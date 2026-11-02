import 'dart:io';

import 'package:path/path.dart' as p;

/// A Local start was refused because the state folder could not be verified.
/// The reason travels with it: the owner is shown this text, and a refusal that
/// does not say which path or which check failed cannot be acted on.
class LocalStateUnsafe implements Exception {
  LocalStateUnsafe(this.message);
  final String message;
  @override
  String toString() => message;
}

/// A real safety violation. Never retried, because the condition is on disk and
/// waiting cannot change it.
class _Unsafe implements Exception {
  _Unsafe(this.message);
  final String message;
}

/// Resolve metadata only, including nonexistent paths through their nearest
/// existing parent. No file contents are opened.
Future<String> _canonical(String input) async {
  var path = p.normalize(p.absolute(input));
  final suffix = <String>[];
  while (await FileSystemEntity.type(path, followLinks: false) ==
      FileSystemEntityType.notFound) {
    final parent = p.dirname(path);
    if (parent == path) throw _Unsafe('Cannot resolve $input');
    suffix.add(p.basename(path));
    path = parent;
  }
  var resolved = await File(path).resolveSymbolicLinks();
  for (final part in suffix.reversed) {
    resolved = p.join(resolved, part);
  }
  return p.normalize(resolved);
}

bool _contains(String parent, String child) {
  // A conservative case-insensitive comparison also protects default macOS
  // volumes and does not weaken checks on case-sensitive filesystems.
  final a = p.normalize(parent).toLowerCase(),
      b = p.normalize(child).toLowerCase();
  return p.equals(a, b) || p.isWithin(a, b);
}

/// Check Local and production path/symlink metadata before creating Local
/// state or starting its backend. Symlinks may stay inside Local, or point to
/// regular executables inside explicitly permitted runtime roots. No link may
/// point into or above a protected production root.
///
/// The walk is retried once or twice on an I/O failure, because a start can race
/// a backend that is still removing its own temporary files: metadata that
/// existed a millisecond ago is gone by the time it is read. A refusal is only
/// raised when the problem is on disk and repeatable.
Future<void> assertLocalStateSafe(
  String localState,
  List<String> productionRoots, {
  List<String> allowedExternalFileRoots = const [],
  List<String> allowedCodexExecutables = const [],
}) async {
  if (!p.isAbsolute(localState) ||
      productionRoots.any((r) => !p.isAbsolute(r)) ||
      allowedExternalFileRoots.any((r) => !p.isAbsolute(r)) ||
      allowedCodexExecutables.any((r) => !p.isAbsolute(r))) {
    throw LocalStateUnsafe('Local and protected paths must be absolute');
  }
  for (var attempt = 1; ; attempt++) {
    try {
      await _verify(
        localState,
        productionRoots,
        allowedExternalFileRoots,
        allowedCodexExecutables,
      );
      return;
    } on _Unsafe catch (error) {
      throw LocalStateUnsafe(error.message);
    } catch (error) {
      if (attempt >= 3) {
        throw LocalStateUnsafe(
          'Could not read the Local state folder ($localState): $error',
        );
      }
      await Future<void>.delayed(const Duration(milliseconds: 150));
    }
  }
}

Future<void> _verify(
  String localState,
  List<String> productionRoots,
  List<String> allowedExternalFileRoots,
  List<String> allowedCodexExecutables,
) async {
  final localType = await FileSystemEntity.type(localState, followLinks: false);
  if (localType == FileSystemEntityType.link) {
    throw _Unsafe('Local state is a symbolic link: $localState');
  }
  final local = await _canonical(localState), protected = <String>[];
  for (final root in productionRoots) {
    protected.add(await _canonical(root));
  }
  if (protected.any((root) => _contains(root, local) || _contains(local, root))) {
    throw _Unsafe('Local state overlaps protected data: $local');
  }
  final allowed = <String>[];
  for (final root in allowedExternalFileRoots) {
    final canonical = await _canonical(root);
    if (protected.any(
      (item) => _contains(item, canonical) || _contains(canonical, item),
    )) {
      throw _Unsafe('Runtime root overlaps protected data: $root');
    }
    allowed.add(canonical);
  }
  final codexExecutables = <String>[];
  for (final executable in allowedCodexExecutables) {
    final canonical = await _canonical(executable);
    if (protected.any(
      (root) => _contains(root, canonical) || _contains(canonical, root),
    )) {
      throw _Unsafe(
        'Codex executable overlaps protected data: $executable',
      );
    }
    codexExecutables.add(canonical);
  }
  if (localType == FileSystemEntityType.notFound) return;
  if (localType != FileSystemEntityType.directory) {
    throw _Unsafe('Local state is not a directory: $localState');
  }
  await for (final item
      in Directory(localState).list(recursive: true, followLinks: false)) {
    // A link whose target is gone cannot be read through, so it is not an escape
    // route. Codex and the package caches leave these behind whenever a session
    // or a download is cleaned up, and treating them as a violation used to stop
    // the app from starting at all with no way to act on it.
    if (await FileSystemEntity.type(item.path, followLinks: true) ==
        FileSystemEntityType.notFound) {
      continue;
    }
    final target = await item.resolveSymbolicLinks();
    if (protected.any(
      (root) => _contains(root, target) || _contains(target, root),
    )) {
      throw _Unsafe('Local link overlaps protected data: ${item.path}');
    }
    if (_contains(local, target)) continue;
    final targetType = await FileSystemEntity.type(target, followLinks: true);
    final parts = p.split(p.relative(item.path, from: localState));
    final isCodexTemporaryLink =
        parts.length == 6 &&
        parts[0] == 'home' &&
        parts[1] == '.codex' &&
        parts[2] == 'tmp' &&
        parts[3] == 'arg0-macos' &&
        RegExp(r'^codex-arg0[A-Za-z0-9_-]+$').hasMatch(parts[4]) &&
        (parts[5] == 'applypatch' || parts[5] == 'apply_patch');
    if (isCodexTemporaryLink &&
        targetType == FileSystemEntityType.file &&
        codexExecutables.any((path) => p.equals(path, target))) {
      final stat = await FileStat.stat(target);
      if (stat.mode & 0x49 != 0) continue;
    }
    final isPythonName =
        parts.isNotEmpty &&
        RegExp(r'^python(?:[0-9]+(?:\.[0-9]+)?)?$').hasMatch(parts.last);
    final isAgentReachPython =
        parts.length == 6 &&
        parts[0] == 'home' &&
        parts[1] == '.local' &&
        parts[2] == 'tools' &&
        parts[3] == 'agent-reach' &&
        parts[4] == 'bin' &&
        isPythonName;
    final isUvPython =
        parts.length == 7 &&
        parts[0] == 'home' &&
        parts[1] == '.cache' &&
        parts[2] == 'uv' &&
        (parts[3] == 'builds-v0' || parts[3] == 'archive-v0') &&
        RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(parts[4]) &&
        parts[5] == 'bin' &&
        isPythonName;
    if (targetType != FileSystemEntityType.file ||
        !(isAgentReachPython || isUvPython) ||
        !allowed.any((root) => _contains(root, target)) ||
        (await FileStat.stat(target)).mode & 0x49 == 0) {
      throw _Unsafe(
        'Local link escapes its permitted paths: ${item.path} -> $target',
      );
    }
  }
}
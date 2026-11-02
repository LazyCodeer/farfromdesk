import 'dart:io';

import 'package:path/path.dart' as p;

/// Resolve metadata only, including nonexistent paths through their nearest
/// existing parent. No file contents are opened.
Future<String> _canonical(String input) async {
  var path = p.normalize(p.absolute(input));
  final suffix = <String>[];
  while (await FileSystemEntity.type(path, followLinks: false) ==
      FileSystemEntityType.notFound) {
    final parent = p.dirname(path);
    if (parent == path) throw const FileSystemException('Cannot verify path');
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
    throw const FileSystemException(
      'Local and protected paths must be absolute',
    );
  }
  try {
    final localType = await FileSystemEntity.type(
      localState,
      followLinks: false,
    );
    if (localType == FileSystemEntityType.link) {
      throw const FileSystemException('Local state is a symbolic link');
    }
    final local = await _canonical(localState), protected = <String>[];
    for (final root in productionRoots) {
      protected.add(await _canonical(root));
    }
    if (protected.any(
      (root) => _contains(root, local) || _contains(local, root),
    )) {
      throw const FileSystemException('Local state overlaps protected data');
    }
    final allowed = <String>[];
    for (final root in allowedExternalFileRoots) {
      final canonical = await _canonical(root);
      if (protected.any(
        (p) => _contains(p, canonical) || _contains(canonical, p),
      )) {
        throw const FileSystemException('Runtime root overlaps protected data');
      }
      allowed.add(canonical);
    }
    final codexExecutables = <String>[];
    for (final executable in allowedCodexExecutables) {
      final canonical = await _canonical(executable);
      if (protected.any(
        (root) => _contains(root, canonical) || _contains(canonical, root),
      )) {
        throw const FileSystemException(
          'Codex executable overlaps protected data',
        );
      }
      codexExecutables.add(canonical);
    }
    if (localType == FileSystemEntityType.notFound) return;
    if (localType != FileSystemEntityType.directory) {
      throw const FileSystemException('Local state is not a directory');
    }
    await for (final item in Directory(
      localState,
    ).list(recursive: true, followLinks: false)) {
      if (await FileSystemEntity.type(item.path, followLinks: false) !=
          FileSystemEntityType.link) {
        continue;
      }
      final target = await item.resolveSymbolicLinks();
      if (protected.any(
        (root) => _contains(root, target) || _contains(target, root),
      )) {
        throw const FileSystemException('Local link overlaps protected data');
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
        throw const FileSystemException(
          'Local link escapes its permitted paths',
        );
      }
    }
  } catch (_) {
    throw const FileSystemException(
      'Cannot verify isolated Local state paths. The backend was not started.',
    );
  }
}

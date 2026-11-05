import 'dart:io';

import 'package:farfromdesk/local_state_guard.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

/// Windows lets only administrators, or accounts with Developer Mode, create
/// links. Those cases are left out there, and the run says why.
final String? noLinks = () {
  if (!Platform.isWindows) return null;
  final dir = Directory.systemTemp.createTempSync('ffd-link-probe-');
  try {
    Link(p.join(dir.path, 'probe')).createSync(dir.path);
    return null;
  } on FileSystemException {
    return 'this Windows account cannot create symlinks';
  } finally {
    dir.deleteSync(recursive: true);
  }
}();

void main() {
  late Directory root, state, production, runtimes;

  setUp(() {
    root = Directory.systemTemp.createTempSync('ffd-guard-');
    state = Directory(p.join(root.path, 'state'))..createSync();
    production = Directory(p.join(root.path, 'production'))
      ..createSync(recursive: true);
    runtimes = Directory(p.join(root.path, 'runtimes'))
      ..createSync(recursive: true);
    File(p.join(production.path, 'bridge.sqlite')).writeAsStringSync('x');
  });

  tearDown(() => root.deleteSync(recursive: true));

  Future<void> check() => assertLocalStateSafe(
    state.path,
    [production.path],
    allowedExternalFileRoots: [runtimes.path],
  );

  test('a missing state folder is fine', () async {
    await assertLocalStateSafe(
      p.join(root.path, 'never-created'),
      [production.path],
    );
  });

  test('a link whose target is gone does not block a start', () async {
    // Codex and the package caches leave these behind when a session or a
    // download is cleaned up. This exact condition used to refuse to start the
    // app at all, with a message that named nothing.
    final dir = Directory(p.join(state.path, 'home', '.codex', 'tmp'))
      ..createSync(recursive: true);
    Link(p.join(dir.path, 'dangling-link')).createSync(
      p.join(root.path, 'target-that-was-removed'),
    );
    await check();
  }, skip: noLinks);

  test('a link into protected data is refused and named', () async {
    final dir = Directory(p.join(state.path, 'home'))..createSync();
    final link = p.join(dir.path, 'to-production');
    Link(link).createSync(p.join(production.path, 'bridge.sqlite'));
    await expectLater(
      check(),
      throwsA(
        isA<LocalStateUnsafe>()
            .having((e) => e.message, 'message', contains(link))
            .having(
              (e) => e.message,
              'message',
              isNot(contains('backend was not started')),
            ),
      ),
    );
  }, skip: noLinks);

  test('a link out of Local to an unpermitted file is refused and named', () async {
    final dir = Directory(p.join(state.path, 'home'))..createSync();
    final link = p.join(dir.path, 'to-shell');
    // A real file outside every permitted root. `/bin/sh` does not exist on
    // Windows, and a link to nothing is allowed on purpose (see above).
    final outside = File(p.join(root.path, 'elsewhere', 'sh'))
      ..createSync(recursive: true);
    Link(link).createSync(outside.path);
    await expectLater(
      check(),
      throwsA(
        isA<LocalStateUnsafe>().having(
          (e) => e.message,
          'message',
          contains('escapes its permitted paths'),
        ),
      ),
    );
  }, skip: noLinks);

  test('a link that stays inside Local is allowed', () async {
    final inside = File(p.join(state.path, 'real.txt'))..writeAsStringSync('x');
    Link(p.join(state.path, 'alias.txt')).createSync(inside.path);
    await check();
  }, skip: noLinks);

  test('relative paths are still refused before anything is touched', () async {
    await expectLater(
      assertLocalStateSafe('state', [production.path]),
      throwsA(isA<LocalStateUnsafe>()),
    );
  });

  group('resolveOwnerHome', () {
    bool exists(String path) => true;

    test('an isolated \$HOME is replaced by the account home', () {
      // The failure this fixes: the app was started with the backend's isolated
      // HOME, so the guard's "protected" roots landed inside Local's own state and
      // the start was refused with "Local state overlaps protected data".
      final resolved = resolveOwnerHome(
        state: state.path,
        home: p.join(state.path, 'home'),
        user: 'someone',
        directoryExists: exists,
      );
      expect(resolved, '/Users/someone');
    });

    test('a real \$HOME is accepted when nothing better is declared', () {
      final resolved = resolveOwnerHome(
        state: state.path,
        home: '/Users/someone',
        user: 'someone',
        directoryExists: exists,
      );
      expect(resolved, '/Users/someone');
    });

    test('the build-time home wins over the environment', () {
      final resolved = resolveOwnerHome(
        state: state.path,
        declared: '/Users/declared',
        home: '/Users/from-env',
        user: 'someone',
        directoryExists: exists,
      );
      expect(resolved, '/Users/declared');
    });

    test('a home that does not exist is skipped', () {
      final resolved = resolveOwnerHome(
        state: state.path,
        declared: '/Users/gone',
        home: '/Users/here',
        directoryExists: (path) => path == '/Users/here',
      );
      expect(resolved, '/Users/here');
    });

    test('nothing usable is refused with something the owner can act on', () {
      expect(
        () => resolveOwnerHome(
          state: state.path,
          home: p.join(state.path, 'home'),
          directoryExists: exists,
        ),
        throwsA(
          isA<LocalStateUnsafe>().having(
            (e) => e.message,
            'message',
            contains('FFD_OWNER_HOME'),
          ),
        ),
      );
    });
  }, skip: Platform.isWindows ? 'Local runs on macOS only; these are POSIX account homes' : false);
}
import 'dart:io';

import 'package:farfromdesk/local_state_guard.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

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
  });

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
  });

  test('a link out of Local to an unpermitted file is refused and named', () async {
    final dir = Directory(p.join(state.path, 'home'))..createSync();
    final link = p.join(dir.path, 'to-shell');
    Link(link).createSync('/bin/sh');
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
  });

  test('a link that stays inside Local is allowed', () async {
    final inside = File(p.join(state.path, 'real.txt'))..writeAsStringSync('x');
    Link(p.join(state.path, 'alias.txt')).createSync(inside.path);
    await check();
  });

  test('relative paths are still refused before anything is touched', () async {
    await expectLater(
      assertLocalStateSafe('state', [production.path]),
      throwsA(isA<LocalStateUnsafe>()),
    );
  });
}
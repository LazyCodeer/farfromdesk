import 'dart:io';

import 'package:farfromdesk/native_gateway.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

void main() {
  test('Brain key reader accepts a bounded synthetic file and rejects missing, oversized and linked files', () async {
    final root = await Directory.systemTemp.createTemp('ffd-social-key-test-');
    final path = p.join(root.path, 'meta-model-api-key');
    addTearDown(() async => root.delete(recursive: true));
    await expectLater(
      readSocialBrainKey(root.path),
      throwsA(isA<StateError>()),
    );
    const fake = 'synthetic-key-only-123456';
    await File(path).writeAsString(fake);
    expect(await readSocialBrainKey(root.path), fake);
    await File(path).writeAsString('x' * 4097);
    await expectLater(
      readSocialBrainKey(root.path),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          isNot(contains('xxx')),
        ),
      ),
    );
    await File(path).delete();
    if (!Platform.isWindows) {
      final target = File(p.join(root.path, 'synthetic-target'));
      await target.writeAsString(fake);
      await Link(path).create(target.path);
      await expectLater(
        readSocialBrainKey(root.path),
        throwsA(isA<StateError>()),
      );
    }
  });
}

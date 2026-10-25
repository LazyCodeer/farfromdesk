import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/native_gateway.dart';

void main() {
  test(
    'first update creates unique attempts inside a new update directory',
    () async {
      final root = await Directory.systemTemp.createTemp('ffd-update-test-');
      try {
        final parent = Directory('${root.path}/new-state/app-update');
        final first = await createUpdateAttempt(parent);
        final second = await createUpdateAttempt(parent);
        expect(await first.exists(), isTrue);
        expect(first.parent.path, parent.path);
        expect(p.basename(first.path), startsWith('attempt-'));
        expect(first.path, isNot(second.path));
        await File('${first.path}/request.json').writeAsString('{}');
        expect(await File('${first.path}/request.json').exists(), isTrue);
      } finally {
        await root.delete(recursive: true);
      }
    },
  );
}

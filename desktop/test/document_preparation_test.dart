import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:farfromdesk/document_preparation.dart';

void main() {
  test('desktop passes a reviewed local reference, without reading or encoding a large file', () async {
    final temp = await Directory.systemTemp.createTemp('ffd-document-');
    final dir = await temp.resolveSymbolicLinks();
    try {
      final file = File(p.join(dir, 'build.bin'));
      final handle = await file.open(mode: FileMode.write);
      await handle.truncate(2000 * 1024 * 1024);
      await handle.close();
      final result = await reviewedDocumentReference(file.path);
      expect(result['filename'], 'build.bin');
      expect(result['_localDocumentPath'], file.path);
      expect(result.containsKey('base64'), isFalse);
      final link = Link(p.join(dir, 'link.bin'));
      try {
        await link.create(file.path);
      } on FileSystemException {
        // Windows lets only administrators, or Developer Mode, create links.
        if (Platform.isWindows) return;
        rethrow;
      }
      await expectLater(reviewedDocumentReference(link.path), throwsStateError);
    } finally {
      await temp.delete(recursive: true);
    }
  });
}

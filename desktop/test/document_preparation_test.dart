import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/document_preparation.dart';

void main() {
  test('desktop passes a reviewed local reference, without reading or encoding a large file', () async {
    final temp = await Directory.systemTemp.createTemp('ffd-document-');
    final dir = await temp.resolveSymbolicLinks();
    try {
      final file = File('$dir/build.bin');
      final handle = await file.open(mode: FileMode.write);
      await handle.truncate(2000 * 1024 * 1024);
      await handle.close();
      final result = await reviewedDocumentReference(file.path);
      expect(result['filename'], 'build.bin');
      expect(result['_localDocumentPath'], file.path);
      expect(result.containsKey('base64'), isFalse);
      final link = Link('$dir/link.bin');
      await link.create(file.path);
      await expectLater(reviewedDocumentReference(link.path), throwsStateError);
    } finally {
      await temp.delete(recursive: true);
    }
  });
}

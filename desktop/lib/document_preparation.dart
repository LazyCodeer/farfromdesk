import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// Keep bytes out of the UI and JSON. The local Node helper enforces exact file
/// identity, links, hashes, native size and streamed preparation at confirmation.
Future<Map<String, dynamic>> reviewedDocumentReference(String path) async {
  final file = File(path);
  if (!p.isAbsolute(path) ||
      p.normalize(path) != path ||
      await file.resolveSymbolicLinks() != path) {
    throw StateError('Choose a canonical regular file without symbolic links.');
  }
  if (await FileSystemEntity.type(path, followLinks: false) !=
      FileSystemEntityType.file) {
    throw StateError('Choose a regular file.');
  }
  return {'filename': p.basename(path), '_localDocumentPath': path};
}

Future<Map<String, dynamic>> prepareDesktopDocument({
  required String node,
  required String root,
  required String state,
  required int port,
  required String path,
  required String bindingId,
  required String requestId,
}) async {
  final process = await Process.start(
    node,
    [p.join(root, 'dist', 'cli.js'), 'prepare-desktop-file'],
    workingDirectory: root,
    environment: {'WSB_STATE_DIR': state, 'WSB_PORT': '$port'},
  );
  Future<String> boundedText(Stream<List<int>> source) async {
    final bytes = <int>[];
    await for (final chunk in source) {
      if (bytes.length + chunk.length > 65536) {
        process.kill();
        throw StateError('Unexpected document preparation output.');
      }
      bytes.addAll(chunk);
    }
    return utf8.decode(bytes, allowMalformed: true);
  }

  final output = boundedText(process.stdout),
      errors = boundedText(process.stderr);
  final completion = Future.wait<Object>([process.exitCode, output, errors]);
  try {
    process.stdin.write(
      jsonEncode({
        'bindingId': bindingId,
        'requestId': requestId,
        'path': path,
      }),
    );
    await process.stdin.close();
    final result = await completion.timeout(const Duration(minutes: 65));
    if (result[0] != 0) throw StateError((result[2] as String).trim());
    final prepared = jsonDecode(result[1] as String) as Map<String, dynamic>;
    if (prepared['artifactId'] is! String) {
      throw StateError(
        'Document preparation did not return a verified artifact.',
      );
    }
    return prepared;
  } catch (_) {
    process.kill();
    rethrow;
  }
}

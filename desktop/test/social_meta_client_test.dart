import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:farfromdesk/social_meta_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const sampleJpeg =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z';
const input = {
  'brief': 'Synthetic topic',
  'research': 'Synthetic research',
  'imagePrompt': 'Synthetic image',
};
const fakeKey = 'synthetic-only-secret';
http.Response jsonResponse(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);
Map<String, dynamic> message(
  String text, {
  bool searched = false,
  List<dynamic> citations = const [],
}) => {
  'status': 'completed',
  'output': [
    if (searched) {'type': 'web_search_call', 'status': 'completed'},
    {
      'type': 'message',
      'content': [
        {'type': 'output_text', 'text': text, 'annotations': citations},
      ],
    },
  ],
};
void main() {
  test('fixed Meta endpoints, model, cost bounds, and consent data for all three actions', () async {
    final calls = <String>[];
    final client = SocialMetaClient(
      clientFactory: () => MockClient((request) async {
        calls.add(request.url.toString());
        expect(request.method, 'POST');
        expect(request.followRedirects, isFalse);
        expect(request.headers['Authorization'], 'Bearer $fakeKey');
        final b = jsonDecode(request.body) as Map<String, dynamic>;
        expect(request.body, isNot(contains(fakeKey)));
        if (request.url.path.endsWith('/images/generations')) {
          expect(b['model'], 'muse-image-1.0');
          expect(b['prompt'], 'Synthetic image');
          expect(b['n'], 1);
          expect(b['tool_enablement'], {
            'enable_image_search': false,
            'enable_web_search': false,
            'enable_shell': false,
          });
          return jsonResponse({
            'output_format': 'jpeg',
            'data': [
              {'b64_json': sampleJpeg},
            ],
          });
        }
        expect(request.url.toString(), 'https://api.meta.ai/v1/responses');
        expect(b['model'], 'muse-spark-1.3');
        expect(b['store'], false);
        if (b.containsKey('tools')) {
          expect(b['max_output_tokens'], 4096);
          expect(b['input'], 'Synthetic topic');
          return jsonResponse(
            message(
              'Synthetic findings',
              searched: true,
              citations: [
                {
                  'type': 'url_citation',
                  'url': 'https://example.com/source',
                  'title': 'Sample',
                },
              ],
            ),
          );
        }
        expect(b['max_output_tokens'], 2048);
        expect(jsonDecode(b['input'] as String), {
          'topic': 'Synthetic topic',
          'research': 'Synthetic research',
        });
        return jsonResponse(message('Synthetic caption'));
      }),
    );
    final research = await client.generate(
      kind: 'research',
      key: fakeKey,
      input: input,
    );
    expect(research['searched'], true);
    expect(research['sources'], [
      {'title': 'Sample', 'url': 'https://example.com/source'},
    ]);
    final caption = await client.generate(
      kind: 'draft',
      key: fakeKey,
      input: input,
    );
    expect(caption['text'], 'Synthetic caption');
    final image = await client.generate(
      kind: 'image',
      key: fakeKey,
      input: input,
    );
    expect(image['base64'], sampleJpeg);
    expect(calls, [
      'https://api.meta.ai/v1/responses',
      'https://api.meta.ai/v1/responses',
      'https://api.meta.ai/v1/images/generations',
    ]);
  });
  test('citations are capped and no-search is explicit', () async {
    final citations = List.generate(
      3000,
      (i) => {
        'type': 'url_citation',
        'url': 'https://example.com/$i',
        'title': 'Synthetic',
      },
    );
    final client = SocialMetaClient(
      clientFactory: () => MockClient(
        (_) async => jsonResponse(message('Findings', citations: citations)),
      ),
    );
    final result = await client.generate(
      kind: 'research',
      key: fakeKey,
      input: input,
    );
    expect(result['searched'], false);
    expect((result['sources'] as List).length, 30);
  });
  test('redirects, transport errors, timeouts and oversized responses are sanitized', () async {
    final redirect = SocialMetaClient(
      clientFactory: () => MockClient(
        (_) async => http.Response(
          '',
          302,
          headers: {'location': 'https://other.example/'},
        ),
      ),
    );
    await expectLater(
      redirect.generate(kind: 'research', key: fakeKey, input: input),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          isNot(contains(fakeKey)),
        ),
      ),
    );
    final failure = SocialMetaClient(
      clientFactory: () => MockClient((_) async => throw StateError(fakeKey)),
    );
    await expectLater(
      failure.generate(kind: 'research', key: fakeKey, input: input),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          isNot(contains(fakeKey)),
        ),
      ),
    );
    final timeout = SocialMetaClient(
      timeout: const Duration(milliseconds: 10),
      clientFactory: () => MockClient((_) => Completer<http.Response>().future),
    );
    await expectLater(
      timeout.generate(kind: 'draft', key: fakeKey, input: input),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('timed out'),
        ),
      ),
    );
    final oversized = SocialMetaClient(
      clientFactory: () =>
          MockClient((_) async => http.Response('x' * 2000001, 200)),
    );
    await expectLater(
      oversized.generate(kind: 'research', key: fakeKey, input: input),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('size limit'),
        ),
      ),
    );
  });
  test('malformed and excessive-dimension JPEGs are rejected', () async {
    Future<void> check(String encoded) async {
      final client = SocialMetaClient(
        clientFactory: () => MockClient(
          (_) async => jsonResponse({
            'output_format': 'jpeg',
            'data': [
              {'b64_json': encoded},
            ],
          }),
        ),
      );
      await expectLater(
        client.generate(kind: 'image', key: fakeKey, input: input),
        throwsA(isA<StateError>()),
      );
    }

    await check(base64Encode([255, 216, 255, 217]));
    final bytes = base64Decode(sampleJpeg);
    var at = -1;
    for (var i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] == 255 && bytes[i + 1] == 0xc0) {
        at = i;
        break;
      }
    }
    expect(at, greaterThan(0));
    bytes[at + 5] = 0x23;
    bytes[at + 6] = 0x28;
    await check(base64Encode(bytes));
  });
  test(
    'large valid JPEG response is accepted without regex stack overflow',
    () async {
      final b = BytesBuilder(copy: false)..add([255, 216]);
      for (var i = 0; i < 115; i++) {
        b.add([255, 224, 255, 254]);
        b.add(Uint8List(65532));
      }
      b.add(base64Decode(sampleJpeg).sublist(2));
      final encoded = base64Encode(b.takeBytes());
      expect(encoded.length, greaterThan(10000000));
      final client = SocialMetaClient(
        clientFactory: () => MockClient(
          (_) async => jsonResponse({
            'output_format': 'jpeg',
            'data': [
              {'b64_json': encoded},
            ],
          }),
        ),
      );
      final result = await client.generate(
        kind: 'image',
        key: fakeKey,
        input: input,
      );
      expect(result['base64'], encoded);
    },
  );
}

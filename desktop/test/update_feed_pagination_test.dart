import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:farfromdesk/updates.dart';

Map<String, dynamic> candidate(
  String version, {
  String target = 'macos-arm64',
  bool checksum = true,
  bool draft = false,
  bool prerelease = false,
  int bodyBytes = 0,
}) {
  final asset = 'FarFromDesk-$version-$target.zip';
  final base =
      'https://github.com/$releaseRepository/releases/download/v$version';
  return {
    'tag_name': 'v$version',
    'draft': draft,
    'prerelease': prerelease,
    'body': 'x' * bodyBytes,
    'assets': [
      {
        'name': asset,
        'state': 'uploaded',
        'size': 123,
        'browser_download_url': '$base/$asset',
      },
      if (checksum)
        {
          'name': '$asset.sha256',
          'state': 'uploaded',
          'size': 64,
          'browser_download_url': '$base/$asset.sha256',
        },
    ],
  };
}

void main() {
  test('large history spans bounded pages and still selects the highest compatible release in the first 20', () async {
    final records = [
      for (var i = 0; i < 20; i++) candidate('0.9.${i + 1}', bodyBytes: 32000),
    ];
    records[0] = candidate(
      '4.0.0-preview.1',
      prerelease: true,
      bodyBytes: 32000,
    );
    records[1] = candidate('3.0.0', draft: true, bodyBytes: 32000);
    records[2] = candidate('2.0.0', target: 'windows-x64', bodyBytes: 32000);
    records[3] = candidate('1.0.0', checksum: false, bodyBytes: 32000);
    records[17] = candidate('0.10.99', bodyBytes: 32000);
    expect(utf8.encode(jsonEncode(records)).length, greaterThan(512 * 1024));
    final requests = <Uri>[];
    final checker = UpdateChecker(
      current: '0.9.0',
      platform: 'macos',
      architecture: 'arm64',
      clientFactory: () => MockClient((request) async {
        requests.add(request.url);
        expect(request.followRedirects, isFalse);
        expect(request.headers.containsKey('Authorization'), isFalse);
        expect(request.url.scheme, 'https');
        expect(request.url.host, 'api.github.com');
        expect(request.url.path, '/repos/$releaseRepository/releases');
        final perPage = int.parse(request.url.queryParameters['per_page']!);
        final page =
            int.tryParse(request.url.queryParameters['page'] ?? '1') ?? 1;
        final start = (page - 1) * perPage;
        final end = (start + perPage).clamp(0, records.length);
        return http.Response(
          jsonEncode(
            start >= records.length ? [] : records.sublist(start, end),
          ),
          200,
        );
      }),
    );
    final result = await checker.check();
    expect(result.problem, isNull);
    expect(result.release?.version, '0.10.99');
    expect(requests.map((url) => url.queryParameters['page'] ?? '1'), [
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(
      requests.every((url) => url.queryParameters['per_page'] == '5'),
      isTrue,
    );
    checker.close();
  });

  test('failure on a later page retains the last complete cache and reports unavailable', () async {
    var now = DateTime.utc(2026, 10, 29), attempt = 0;
    Map<String, dynamic>? saved;
    final checker = UpdateChecker(
      current: '0.9.0',
      platform: 'macos',
      architecture: 'arm64',
      clock: () => now,
      save: (data) async => saved = data,
      clientFactory: () => MockClient((request) async {
        final page =
            int.tryParse(request.url.queryParameters['page'] ?? '1') ?? 1;
        if (attempt == 0) {
          return http.Response(jsonEncode([candidate('0.9.1')]), 200);
        }
        if (page == 1) {
          return http.Response(
            jsonEncode([for (var i = 0; i < 5; i++) candidate('0.10.$i')]),
            200,
          );
        }
        return http.Response('unavailable', 503);
      }),
    );
    final success = await checker.check();
    expect(success.release?.version, '0.9.1');
    final original = jsonEncode(saved!['releases']);
    now = now.add(const Duration(minutes: 2));
    attempt++;
    final failure = await checker.check(manual: true);
    expect(failure.problem, isNotNull);
    expect(failure.release?.version, '0.9.1');
    expect(saved!['failed'], isTrue);
    expect(jsonEncode(saved!['releases']), original);
    checker.close();
  });

  test('invalid, oversized or redirected later pages never appear as a successful check', () async {
    final first = [for (var i = 0; i < 5; i++) candidate('0.10.$i')];
    for (final response in [
      http.Response('{}', 200),
      http.Response('x' * (512 * 1024 + 1), 200),
      http.Response('redirect', 302),
    ]) {
      final checker = UpdateChecker(
        current: '0.9.0',
        platform: 'macos',
        architecture: 'arm64',
        clientFactory: () => MockClient((request) async {
          final page =
              int.tryParse(request.url.queryParameters['page'] ?? '1') ?? 1;
          return page == 1 ? http.Response(jsonEncode(first), 200) : response;
        }),
      );
      final result = await checker.check();
      expect(result.problem, isNotNull);
      expect(result.release, isNull);
      checker.close();
    }
  });

  test('manual retries still honor the one minute cooldown across paginated requests', () async {
    var now = DateTime.utc(2026, 10, 29), requests = 0;
    final checker = UpdateChecker(
      current: '0.9.0',
      platform: 'macos',
      architecture: 'arm64',
      clock: () => now,
      clientFactory: () => MockClient((request) async {
        requests++;
        final page =
            int.tryParse(request.url.queryParameters['page'] ?? '1') ?? 1;
        return http.Response(
          jsonEncode(
            page == 1 ? [for (var i = 0; i < 5; i++) candidate('0.10.$i')] : [],
          ),
          200,
        );
      }),
    );
    await checker.check(manual: true);
    expect(requests, 2);
    await checker.check(manual: true);
    expect(requests, 2);
    now = now.add(const Duration(minutes: 1));
    await checker.check(manual: true);
    expect(requests, 4);
    checker.close();
  });
  test('aggregate metadata budget fails closed even when every page is under its own cap', () async {
    var calls = 0;
    final page = jsonEncode([
      for (var i = 0; i < 5; i++) candidate('0.10.$i', bodyBytes: 85000),
    ]);
    expect(utf8.encode(page).length, lessThan(512 * 1024));
    final checker = UpdateChecker(
      current: '0.9.0',
      platform: 'macos',
      architecture: 'arm64',
      clientFactory: () => MockClient((request) async {
        calls++;
        return http.Response(page, 200);
      }),
    );
    final result = await checker.check();
    expect(calls, 4);
    expect(result.problem, isNotNull);
    expect(result.release, isNull);
    checker.close();
  });

  testWidgets(
    'one deadline covers all pages and no further page starts after timeout',
    (tester) async {
      var calls = 0;
      final checker = UpdateChecker(
        current: '0.9.0',
        platform: 'macos',
        architecture: 'arm64',
        clientFactory: () => MockClient((request) async {
          calls++;
          await Future<void>.delayed(const Duration(seconds: 8));
          return http.Response(
            jsonEncode([for (var i = 0; i < 5; i++) candidate('0.10.$i')]),
            200,
          );
        }),
      );
      final pending = checker.check();
      await tester.pump();
      expect(calls, 1);
      for (var page = 2; page <= 4; page++) {
        await tester.pump(const Duration(seconds: 8));
        expect(calls, page);
      }
      await tester.pump(const Duration(seconds: 6));
      final result = await pending;
      expect(result.problem, contains('internet connection'));
      expect(result.release, isNull);
      await tester.pump(const Duration(seconds: 8));
      expect(calls, 4);
      checker.close();
    },
  );

  testWidgets('a stalled page times out on its own', (tester) async {
    var calls = 0;
    final checker = UpdateChecker(
      current: '0.9.0',
      platform: 'macos',
      architecture: 'arm64',
      clientFactory: () => MockClient((request) async {
        calls++;
        await Future<void>.delayed(const Duration(seconds: 20));
        return http.Response('[]', 200);
      }),
    );
    final pending = checker.check();
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    final result = await pending;
    expect(result.problem, contains('internet connection'));
    expect(calls, 1);
    await tester.pump(const Duration(seconds: 10));
    checker.close();
  });

  test('each failure says why the check failed', () async {
    Future<String?> problemFor(int status, [String body = '[]']) async {
      final checker = UpdateChecker(
        current: '0.9.0',
        platform: 'macos',
        architecture: 'arm64',
        clientFactory: () =>
            MockClient((request) async => http.Response(body, status)),
      );
      final result = await checker.check();
      checker.close();
      return result.problem;
    }

    expect(await problemFor(403), contains('limiting update checks'));
    expect(await problemFor(429), contains('limiting update checks'));
    expect(await problemFor(404), contains('private or missing'));
    expect(await problemFor(502), contains('temporarily unavailable'));
    expect(await problemFor(200, '{}'), contains('cannot read'));
  });

  testWidgets('closing an in-flight checker stops later page requests', (
    tester,
  ) async {
    var calls = 0;
    final checker = UpdateChecker(
      current: '0.9.0',
      platform: 'macos',
      architecture: 'arm64',
      clientFactory: () => MockClient((request) async {
        calls++;
        await Future<void>.delayed(const Duration(seconds: 8));
        return http.Response(
          jsonEncode([for (var i = 0; i < 5; i++) candidate('0.10.$i')]),
          200,
        );
      }),
    );
    final pending = checker.check();
    await tester.pump();
    checker.close();
    await tester.pump(const Duration(seconds: 8));
    final result = await pending;
    expect(result.problem, isNotNull);
    expect(calls, 1);
  });
}

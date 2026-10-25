import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:farfromdesk/updates.dart';

Map<String, dynamic> release(
  String version, {
  String target = 'macos-arm64',
  bool draft = false,
  bool checksum = true,
}) {
  final name = 'FarFromDesk-$version-$target.zip';
  final base =
      'https://github.com/$releaseRepository/releases/download/v$version';
  return {
    'tag_name': 'v$version',
    'draft': draft,
    'prerelease': version.contains('-'),
    'assets': [
      {
        'name': name,
        'size': 500000000,
        'state': 'uploaded',
        'browser_download_url': '$base/$name',
      },
      if (checksum)
        {
          'name': '$name.sha256',
          'size': 64,
          'state': 'uploaded',
          'browser_download_url': '$base/$name.sha256',
        },
    ],
  };
}

void main() {
  test('semantic version comparison handles numeric previews, stable, and metadata', () {
    int compare(String a, String b) =>
        ReleaseVersion.parse(a)!.compareTo(ReleaseVersion.parse(b)!);
    expect(compare('0.7.0-preview.10', '0.7.0-preview.9'), greaterThan(0));
    expect(compare('v0.7.0', '0.7.0-preview.999'), greaterThan(0));
    expect(compare('0.8.0', '0.7.9'), greaterThan(0));
    expect(compare('0.7.0+42', '0.7.0+41'), 0);
    expect(ReleaseVersion.parse('bad'), isNull);
  });
  test('selects newer compatible release, ignores drafts, downgrades, incomplete assets and prereleases for stable', () {
    expect(
      selectRelease(
        [release('0.6.9'), release('0.7.0')],
        '0.7.0',
        'macos',
        'arm64',
      ),
      isNull,
    );
    expect(
      selectRelease([release('0.8.0-preview.1')], '0.7.0', 'macos', 'arm64'),
      isNull,
    );
    expect(
      selectRelease(
        [release('0.8.0', checksum: false)],
        '0.7.0',
        'macos',
        'arm64',
      ),
      isNull,
    );
    expect(
      selectRelease([release('0.8.0', draft: true)], '0.7.0', 'macos', 'arm64'),
      isNull,
    );
    expect(selectRelease([release('0.8.0')], '0.7.0', 'macos', 'x64'), isNull);
    final result = selectRelease(
      [release('0.8.0'), release('0.9.0')],
      '0.7.0',
      'macos',
      'arm64',
    );
    expect(result!.version, '0.9.0');
    expect(
      selectRelease(
        [release('0.7.0-preview.10')],
        '0.7.0-preview.9',
        'macos',
        'arm64',
      )!.version,
      '0.7.0-preview.10',
    );
  });
  test('download must match the exact official versioned asset URL', () {
    final data = release('0.8.0');
    (data['assets'] as List)[0]['browser_download_url'] =
        'https://evil.example/installer.zip';
    expect(selectRelease([data], '0.7.0', 'macos', 'arm64'), isNull);
    expect(
      trustedReleaseUrl(
        Uri.parse(
          'https://github.com.evil.test/LazyCodeer/farfromdesk/releases/1',
        ),
      ),
      false,
    );
    expect(trustedReleaseUrl(Uri.parse('file:///tmp/update.sh')), false);
    expect(
      trustedReleaseUrl(
        Uri.parse(
          'https://github.com/LazyCodeer/farfromdesk/releases/tag/v0.8.0',
        ),
      ),
      true,
    );
  });
  test(
    'checks share one request and cache across automatic polls and app restart',
    () async {
      var now = DateTime.utc(2026, 10, 25), calls = 0;
      Map<String, dynamic>? saved;
      http.Client factory() => MockClient((request) async {
        calls++;
        expect(request.headers.containsKey('Authorization'), false);
        expect(request.url.host, 'api.github.com');
        return http.Response(jsonEncode([release('0.8.0')]), 200);
      });
      final checker = UpdateChecker(
        current: '0.7.0',
        platform: 'macos',
        architecture: 'arm64',
        clock: () => now,
        clientFactory: factory,
        save: (data) async => saved = data,
      );
      final results = await Future.wait([checker.check(), checker.check()]);
      expect(calls, 1);
      expect(results.first.release!.version, '0.8.0');
      await checker.check();
      expect(calls, 1);
      final restored = UpdateChecker(
        current: '0.7.0',
        platform: 'macos',
        architecture: 'arm64',
        clock: () => now,
        clientFactory: factory,
      )..restore(saved!);
      expect((await restored.check()).release!.version, '0.8.0');
      expect(calls, 1);
      now = now.add(const Duration(hours: 6));
      await restored.check();
      expect(calls, 2);
      checker.close();
      restored.close();
    },
  );
  test('private/rate-limited/broken feeds are unavailable, not up to date; last valid update survives offline', () async {
    var now = DateTime.utc(2026, 10, 25), code = 200, calls = 0;
    final checker = UpdateChecker(
      current: '0.7.0',
      platform: 'macos',
      architecture: 'arm64',
      clock: () => now,
      clientFactory: () => MockClient((_) async {
        calls++;
        return http.Response(
          code == 200 ? jsonEncode([release('0.8.0')]) : 'Unavailable',
          code,
        );
      }),
    );
    expect((await checker.check()).release, isNotNull);
    now = now.add(const Duration(minutes: 2));
    code = 404;
    final failed = await checker.check(manual: true);
    expect(failed.problem, isNotNull);
    expect(failed.release, isNotNull);
    await checker.check(manual: true);
    expect(calls, 2);
    final fresh = UpdateChecker(
      current: '0.7.0',
      platform: 'macos',
      architecture: 'arm64',
      clientFactory: () => MockClient((_) async => http.Response('limit', 403)),
    );
    final limited = await fresh.check();
    expect(limited.problem, isNotNull);
    expect(limited.release, isNull);
    checker.close();
    fresh.close();
  });
  test('bad or oversized metadata cannot create an update banner', () async {
    for (final body in ['{}', 'not json', 'x' * (512 * 1024 + 1)]) {
      final checker = UpdateChecker(
        current: '0.7.0',
        platform: 'macos',
        architecture: 'arm64',
        clientFactory: () => MockClient((_) async => http.Response(body, 200)),
      );
      final result = await checker.check();
      expect(result.problem, isNotNull);
      expect(result.release, isNull);
      checker.close();
    }
  });
}

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

const installedVersion = String.fromEnvironment(
  'FFD_VERSION',
  defaultValue: '0.7.0',
);
const releaseRepository = 'LazyCodeer/farfromdesk';

/// Semantic versions, including numeric preview identifiers (preview.10 > preview.9).
class ReleaseVersion implements Comparable<ReleaseVersion> {
  final List<int> core;
  final List<String> pre;
  ReleaseVersion(this.core, this.pre);
  static ReleaseVersion? parse(String value) {
    final match = RegExp(
      r'^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$',
    ).firstMatch(value);
    if (match == null) return null;
    return ReleaseVersion([
      for (var i = 1; i <= 3; i++) int.parse(match[i]!),
    ], match[4]?.split('.') ?? []);
  }

  @override
  int compareTo(ReleaseVersion other) {
    for (var i = 0; i < 3; i++) {
      final result = core[i].compareTo(other.core[i]);
      if (result != 0) return result;
    }
    if (pre.isEmpty || other.pre.isEmpty) {
      return pre.isEmpty == other.pre.isEmpty
          ? 0
          : pre.isEmpty
          ? 1
          : -1;
    }
    for (var i = 0; i < pre.length && i < other.pre.length; i++) {
      final a = int.tryParse(pre[i]), b = int.tryParse(other.pre[i]);
      final result = a != null && b != null
          ? a.compareTo(b)
          : a != null
          ? -1
          : b != null
          ? 1
          : pre[i].compareTo(other.pre[i]);
      if (result != 0) return result;
    }
    return pre.length.compareTo(other.pre.length);
  }
}

class AppRelease {
  final String version;
  final Uri download, notes;
  final int bytes;
  const AppRelease(this.version, this.download, this.notes, this.bytes);
}

class UpdateCheck {
  final AppRelease? release;
  final String? problem;
  final DateTime? checkedAt;
  const UpdateCheck({this.release, this.problem, this.checkedAt});
}

bool trustedReleaseUrl(Uri url) =>
    url.scheme == 'https' &&
    url.host == 'github.com' &&
    !url.hasPort &&
    url.userInfo.isEmpty &&
    !url.hasQuery &&
    !url.hasFragment &&
    url.path.startsWith('/$releaseRepository/releases/') &&
    !url.pathSegments.contains('..');

AppRelease? selectRelease(
  Object? data,
  String current,
  String platform,
  String architecture,
) {
  final parsed = ReleaseVersion.parse(current);
  final installed = parsed?.pre.firstOrNull == 'local'
      ? ReleaseVersion(parsed!.core, [])
      : parsed;
  if (installed == null || data is! List) {
    throw const FormatException('Invalid release information');
  }
  AppRelease? best;
  for (final item in data) {
    if (item is! Map ||
        item['draft'] != false ||
        item['tag_name'] is! String ||
        item['assets'] is! List) {
      continue;
    }
    final tag = item['tag_name'] as String;
    final version = ReleaseVersion.parse(tag);
    if (version == null ||
        version.compareTo(installed) <= 0 ||
        (installed.pre.isEmpty &&
            (version.pre.isNotEmpty || item['prerelease'] != false))) {
      continue;
    }
    if (best != null &&
        version.compareTo(ReleaseVersion.parse(best.version)!) <= 0) {
      continue;
    }
    final nameVersion = tag.startsWith('v') ? tag.substring(1) : tag;
    final notes = Uri.https(
      'github.com',
      '/$releaseRepository/releases/tag/$tag',
    );
    final extensions = platform == 'macos'
        ? ['zip']
        : platform == 'windows'
        ? ['exe', 'zip']
        : ['tar.gz'];
    for (final ext in extensions) {
      final name = ext == 'exe'
          ? 'FarFromDesk-$nameVersion-$platform-$architecture-setup.exe'
          : 'FarFromDesk-$nameVersion-$platform-$architecture.$ext';
      final expected = Uri.https(
        'github.com',
        '/$releaseRepository/releases/download/$tag/$name',
      );
      final assets = (item['assets'] as List).whereType<Map>();
      final matches = assets.where(
        (a) =>
            a['name'] == name &&
            a['state'] == 'uploaded' &&
            a['browser_download_url'] == expected.toString() &&
            a['size'] is int &&
            a['size'] > 0,
      );
      // A release must include this platform's checksum, not just a source archive.
      final checksum = assets.any(
        (a) =>
            a['name'] == '$name.sha256' &&
            a['state'] == 'uploaded' &&
            a['browser_download_url'] == '$expected.sha256',
      );
      if (matches.length != 1 || !checksum) continue;
      best = AppRelease(nameVersion, expected, notes, matches.single['size']);
      break;
    }
  }
  return best;
}

/// Bounded public metadata checks every six hours; never carries local credentials.
class UpdateChecker {
  final String current, platform, architecture;
  final http.Client Function() clientFactory;
  final DateTime Function() clock;
  final Future<void> Function(Map<String, dynamic>)? save;
  UpdateCheck latest = const UpdateCheck();
  DateTime? attemptedAt;
  Future<UpdateCheck>? _pending;
  Object? _cachedData;
  bool _closed = false;
  http.Client? _client;
  UpdateChecker({
    required this.current,
    required this.platform,
    required this.architecture,
    http.Client Function()? clientFactory,
    DateTime Function()? clock,
    this.save,
  }) : clientFactory = clientFactory ?? http.Client.new,
       clock = clock ?? DateTime.now;

  void restore(Map<String, dynamic> cache) {
    try {
      if (cache['current'] != current ||
          cache['platform'] != platform ||
          cache['architecture'] != architecture) {
        return;
      }
      final at = DateTime.parse(cache['at']);
      if (at.isAfter(clock()) ||
          clock().difference(at) > const Duration(days: 7)) {
        return;
      }
      attemptedAt = at;
      _cachedData = cache['releases'];
      latest = UpdateCheck(
        release: selectRelease(
          _cachedData ?? [],
          current,
          platform,
          architecture,
        ),
        problem: cache['failed'] == true
            ? 'Could not check for updates. Try again later.'
            : null,
        checkedAt: at,
      );
    } catch (_) {
      /* Ignore incomplete/old cache; never execute anything from it. */
    }
  }

  Future<UpdateCheck> check({bool manual = false}) {
    if (_pending != null) return _pending!;
    final interval = manual
        ? const Duration(minutes: 1)
        : const Duration(hours: 6);
    if (_closed ||
        (attemptedAt != null &&
            !attemptedAt!.isAfter(clock()) &&
            clock().difference(attemptedAt!) < interval)) {
      return Future.value(latest);
    }
    _pending = _fetch().whenComplete(() => _pending = null);
    return _pending!;
  }

  Future<UpdateCheck> _fetch() async {
    attemptedAt = clock();
    final client = clientFactory();
    _client = client;
    // A full GitHub release object includes notes and every asset. Fetching 20
    // at once eventually exceeds the old 512 KiB response cap as history grows.
    // Keep the same 20-release selection window, with independent page and
    // aggregate byte limits and one deadline for the entire check.
    var active = true;
    try {
      final data = await (() async {
        const pageSize = 5, maxPages = 4;
        const maxPageBytes = 512 * 1024, maxTotalBytes = 1536 * 1024;
        var totalBytes = 0;
        final releases = <dynamic>[];
        for (var page = 1; page <= maxPages; page++) {
          if (!active || _closed) throw const FormatException('Check stopped');
          final request = http.Request(
            'GET',
            Uri.https('api.github.com', '/repos/$releaseRepository/releases', {
              'per_page': '$pageSize',
              'page': '$page',
            }),
          )..followRedirects = false;
          request.headers.addAll({
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'FarFromDesk-update-check',
          });
          final response = await client.send(request);
          if (!active || _closed) throw const FormatException('Check stopped');
          if (response.statusCode != 200) {
            throw const FormatException('Release feed unavailable');
          }
          final bytes = <int>[];
          await for (final part in response.stream) {
            if (!active || _closed) {
              throw const FormatException('Check stopped');
            }
            if (bytes.length + part.length > maxPageBytes ||
                totalBytes + bytes.length + part.length > maxTotalBytes) {
              throw const FormatException('Release feed too large');
            }
            bytes.addAll(part);
          }
          totalBytes += bytes.length;
          final result = jsonDecode(utf8.decode(bytes));
          if (result is! List || result.length > pageSize) {
            throw const FormatException('Invalid release page');
          }
          releases.addAll(result);
          if (result.length < pageSize) break;
        }
        return releases;
      })().timeout(const Duration(seconds: 12));
      final release = selectRelease(data, current, platform, architecture);
      _cachedData = data;
      latest = UpdateCheck(release: release, checkedAt: attemptedAt);
    } catch (_) {
      // A failed/private/offline feed is not evidence that the app is up to date.
      latest = UpdateCheck(
        release: latest.release,
        problem: 'Could not check for updates. Releases may be private or temporarily unavailable.',
        checkedAt: attemptedAt,
      );
    } finally {
      active = false;
      client.close();
      _client = null;
    }
    try {
      await save?.call({
        'current': current,
        'platform': platform,
        'architecture': architecture,
        'at': attemptedAt!.toIso8601String(),
        'failed': latest.problem != null,
        'releases': _cachedData ?? [],
      });
    } catch (_) {}
    return latest;
  }

  void close() {
    _closed = true;
    _client?.close();
  }
}

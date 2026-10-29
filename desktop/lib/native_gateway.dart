import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ffi';

import 'package:file_selector/file_selector.dart';
import 'package:http/http.dart' as http;
import 'package:launch_at_startup/launch_at_startup.dart';
import 'package:path/path.dart' as p;

import 'gateway.dart';
import 'updates.dart';
import 'document_preparation.dart';

Future<Directory> createUpdateAttempt(Directory directory) async {
  await directory.create(recursive: true);
  return directory.createTemp('attempt-');
}

/// Orders two release build ids; null when either is not a release version.
int? compareBuilds(Object? running, Object? ours) {
  final a = ReleaseVersion.parse('$running'), b = ReleaseVersion.parse('$ours');
  return a == null || b == null ? null : a.compareTo(b);
}

class NativeGateway extends Gateway {
  final String state;
  final int port;
  String? _token;
  NativeGateway()
    : state = stateDirectory(),
      port = int.parse(Platform.environment['WSB_PORT'] ?? '47831');
  @override
  String get platform => Platform.operatingSystem;
  @override
  String get computerName => Platform.localHostname;
  static String stateDirectory() {
    final e = Platform.environment;
    if (e['WSB_STATE_DIR'] != null) return e['WSB_STATE_DIR']!;
    final home = e[Platform.isWindows ? 'USERPROFILE' : 'HOME']!;
    if (Platform.isMacOS) {
      return p.join(
        home,
        'Library',
        'Application Support',
        'WhatsApp Session Bridge',
      );
    }
    if (Platform.isWindows) {
      return p.join(
        e['LOCALAPPDATA'] ?? p.join(home, 'AppData', 'Local'),
        'FarFromDesk',
      );
    }
    return p.join(
      e['XDG_DATA_HOME'] ?? p.join(home, '.local', 'share'),
      'farfromdesk',
    );
  }

  Future<UpdateChecker>? _updateChecker;
  bool _updatesClosed = false;
  Future<UpdateChecker> loadUpdateChecker() async {
    final abi = Abi.current();
    final arch =
        [Abi.macosArm64, Abi.linuxArm64, Abi.windowsArm64].contains(abi)
        ? 'arm64'
        : [Abi.macosX64, Abi.linuxX64, Abi.windowsX64].contains(abi)
        ? 'x64'
        : 'unsupported';
    final file = File(p.join(state, 'update-check.json'));
    final checker = UpdateChecker(
      current: installedVersion,
      platform: Platform.isMacOS ? 'macos' : Platform.operatingSystem,
      architecture: arch,
      save: (data) async {
        if (_updatesClosed) return;
        await file.parent.create(recursive: true);
        final temporary = File('${file.path}.tmp');
        await temporary.writeAsString(jsonEncode(data), flush: true);
        await temporary.rename(file.path);
      },
    );
    try {
      if (await file.exists() && await file.length() <= 600 * 1024) {
        checker.restore(jsonDecode(await file.readAsString()));
      }
    } catch (_) {}
    if (_updatesClosed) checker.close();
    return checker;
  }

  @override
  Future<UpdateCheck> checkUpdates({bool manual = false}) async {
    if (Platform.environment['FFD_SMOKE_TEST'] == '1') {
      return const UpdateCheck();
    }
    final checker = await (_updateChecker ??= loadUpdateChecker());
    return checker.check(manual: manual);
  }

  @override
  void closeUpdates() {
    _updatesClosed = true;
    _updateChecker?.then((checker) => checker.close());
  }

  @override
  Future<void> openReleasePage(Uri uri) async {
    if (!trustedReleaseUrl(uri)) {
      throw StateError('Unrecognized release download location.');
    }
    await _openBrowser(uri);
  }

  @override
  Future<void> openVoiceSignup(Uri uri) async {
    if (!voiceSignupUrls.contains(uri)) {
      throw StateError('Unrecognized sign-up page.');
    }
    await _openBrowser(uri);
  }

  @override
  Future<void> openTelegram(Uri uri) async {
    if (uri.scheme != 'https' ||
        uri.host != 't.me' ||
        uri.hasPort ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment ||
        !RegExp(r'^/[A-Za-z0-9_]{5,32}$').hasMatch(uri.path) ||
        uri.queryParameters.keys.any((k) => k != 'start') ||
        (uri.queryParameters.containsKey('start') &&
            !RegExp(r'^[A-Za-z0-9_-]{1,64}$')
                .hasMatch(uri.queryParameters['start']!))) {
      throw StateError('Unrecognized Telegram link.');
    }
    await _openBrowser(uri);
  }

  Future<void> _openBrowser(Uri uri) async {
    final command = Platform.isMacOS
        ? '/usr/bin/open'
        : Platform.isWindows
        ? p.join(
            Platform.environment['SystemRoot'] ?? r'C:\Windows',
            'System32',
            'rundll32.exe',
          )
        : 'xdg-open';
    final result = await Process.run(command, [
      if (Platform.isWindows) 'url.dll,FileProtocolHandler',
      uri.toString(),
    ]);
    if (result.exitCode != 0) {
      throw StateError(
        'Could not open your browser. Try again after checking your default browser.',
      );
    }
  }

  @override
  bool get canInstallUpdate =>
      Platform.isMacOS ||
      (Platform.isWindows && Abi.current() == Abi.windowsX64);
  bool _installing = false;
  @override
  Future<void> installUpdate(
    AppRelease release,
    void Function(Map<String, dynamic>) progress,
  ) async {
    if (Platform.isWindows) {
      return _installWindowsUpdate(release, progress);
    }
    if (!Platform.isMacOS || _installing) {
      throw StateError('An update is already running or unavailable.');
    }
    if (!trustedReleaseUrl(release.download) ||
        !release.download.path.endsWith('.zip')) {
      throw StateError(
        'A verified ZIP update is required. Check for updates again.',
      );
    }
    _installing = true;
    Timer? poll;
    try {
      final app = p.normalize(
        p.join(p.dirname(Platform.resolvedExecutable), '..', '..'),
      );
      final root = p.join(app, 'Contents', 'Resources', 'backend');
      final directory = Directory(p.join(state, 'app-update'));
      await directory.create(recursive: true);
      if (await Directory(p.join(directory.path, 'lock')).exists()) {
        throw StateError(
          'An update is already in progress. Check its status before retrying.',
        );
      }
      final attempt = await createUpdateAttempt(directory);
      final runner = File(p.join(attempt.path, 'app-updater.mjs'));
      await File(p.join(root, 'dist', 'app-updater.js')).copy(runner.path);
      final request = File(p.join(attempt.path, 'request.json'));
      await request.writeAsString(
        jsonEncode({
          'app': app,
          'state': state,
          'port': port,
          'version': release.version,
          'current': installedVersion,
          'uiPid': pid,
        }),
        flush: true,
      );
      final status = File(p.join(directory.path, 'status.json'));
      if (await status.exists()) await status.delete();
      final helper = await Process.start(p.join(root, 'runtime', 'node'), [
        runner.path,
        '--run',
        request.path,
      ]);
      // No shell; the independent helper stays alive while it restarts this UI.
      unawaited(helper.stdout.drain<void>());
      final errors = helper.stderr.transform(utf8.decoder).join();
      Future<Map<String, dynamic>?> readProgress() async {
        try {
          final value =
              jsonDecode(await status.readAsString()) as Map<String, dynamic>;
          if (value['pid'] == helper.pid) {
            progress(value);
            return value;
          }
        } catch (_) {}
        return null;
      }

      poll = Timer.periodic(
        const Duration(milliseconds: 700),
        (_) => readProgress(),
      );
      final code = await helper.exitCode;
      final latest = await readProgress();
      final detail = await errors;
      if (code != 0 || latest?['phase'] != 'complete') {
        throw StateError(
          latest?['message']?.toString() ??
              (detail.isEmpty
                  ? 'The update helper stopped before installation.'
                  : detail.trim()),
        );
      }
    } finally {
      poll?.cancel();
      _installing = false;
    }
  }

  Future<void> _installWindowsUpdate(
    AppRelease release,
    void Function(Map<String, dynamic>) progress,
  ) async {
    if (!canInstallUpdate || _installing) {
      throw StateError('An update is already running or unavailable.');
    }
    if (!trustedReleaseUrl(release.download) ||
        !release.download.path.endsWith('-windows-x64-setup.exe')) {
      throw StateError(
        'A verified Windows EXE update is required. Check for updates again.',
      );
    }
    _installing = true;
    try {
      final app = p.dirname(Platform.resolvedExecutable);
      final root = p.join(app, 'backend');
      final directory = Directory(p.join(state, 'app-update'));
      if (await Directory(p.join(directory.path, 'lock')).exists()) {
        throw StateError(
          'An update is already in progress. Check its status before retrying.',
        );
      }
      final attempt = Directory(
        await (await createUpdateAttempt(directory)).resolveSymbolicLinks(),
      );
      // Copy the runtime too: executing the installed node.exe would lock it.
      final runtime = await File(p.join(root, 'runtime', 'node.exe'))
          .copy(p.join(attempt.path, 'node.exe'));
      for (final name in ['windows-updater.js', 'app-updater.js']) {
        await File(p.join(root, 'dist', name)).copy(p.join(attempt.path, name));
      }
      await File(p.join(attempt.path, 'package.json'))
          .writeAsString('{"type":"module"}', flush: true);
      final request = File(p.join(attempt.path, 'request.json'));
      await request.writeAsString(
        jsonEncode({
          'app': app,
          'state': state,
          'port': port,
          'version': release.version,
          'current': installedVersion,
          'uiPid': pid,
        }),
        flush: true,
      );
      final helper = await Process.start(
        runtime.path,
        [p.join(attempt.path, 'windows-updater.js'), '--run', request.path],
        workingDirectory: attempt.path,
        mode: ProcessStartMode.detached,
      );
      final status = File(p.join(directory.path, 'status.json'));
      var polls = 0;
      while (true) {
        Map<String, dynamic>? value;
        try {
          value =
              jsonDecode(await status.readAsString()) as Map<String, dynamic>;
        } catch (_) {}
        if (value?['pid'] == helper.pid && value?['attempt'] == attempt.path) {
          progress(value!);
          if (value['phase'] == 'error') {
            // A pre-install failure can leave the service stopped with this UI open.
            // Wait for the helper to release its lock before reconnecting.
            for (
              var i = 0;
              i < 50 &&
                  await Directory(p.join(directory.path, 'lock')).exists();
              i++
            ) {
              await Future<void>.delayed(const Duration(milliseconds: 100));
            }
            await start();
            throw StateError(
              value['message']?.toString() ?? 'The update could not finish.',
            );
          }
          if (value['phase'] == 'complete') return;
        }
        if (++polls % 10 == 0) {
          final processes = await Process.run(
            p.join(
              Platform.environment['SystemRoot'] ?? r'C:\Windows',
              'System32',
              'tasklist.exe',
            ),
            ['/FI', 'PID eq ${helper.pid}', '/FO', 'CSV', '/NH'],
          );
          if (processes.exitCode == 0 &&
              !processes.stdout.toString().contains('","${helper.pid}",')) {
            throw StateError(
              'The update helper stopped. Reopen FarFromDesk to review its status.',
            );
          }
        }
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }
    } finally {
      _installing = false;
    }
  }

  /// Stops an older backend that answered with this account's own admin token,
  /// so it is ours. It refuses while a request is running and says so.
  Future<void> _stopOlderBackend() async {
    await post('/api/update-shutdown', {});
    for (var i = 0; i < 60; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      try {
        await get('/api/health');
      } on SocketException {
        return;
      } on http.ClientException {
        return;
      } on TimeoutException {
        return;
      }
    }
    throw StateError(
      'The previous FarFromDesk version did not stop. Quit it from the menu bar or system tray, then try again.',
    );
  }

  Future<void> start() async {
    if (Platform.isWindows &&
        await Directory(p.join(state, 'app-update', 'lock')).exists()) {
      Map<String, dynamic>? updateState;
      try {
        updateState = jsonDecode(
          await File(p.join(state, 'app-update', 'status.json')).readAsString(),
        ) as Map<String, dynamic>;
      } catch (_) {}
      if (![
        'restarting',
        'complete',
        'error',
      ].contains(updateState?['phase'])) {
        throw StateError(
          'FarFromDesk is updating. Wait for it to restart; do not run the installer again.',
        );
      }
    }
    launchAtStartup.setup(
      appName: 'FarFromDesk',
      appPath: Platform.resolvedExecutable,
      packageName: 'com.codecylabs.farfromdesk',
    );
    final executableDir = p.dirname(Platform.resolvedExecutable);
    final root =
        Platform.environment['FFD_BACKEND_ROOT'] ??
        (Platform.isMacOS
            ? p.normalize(p.join(executableDir, '..', 'Resources', 'backend'))
            : p.join(executableDir, 'backend'));
    final buildFile = File(p.join(root, 'build.json'));
    final expectedBuild = await buildFile.exists()
        ? jsonDecode(await buildFile.readAsString()) as Map<String, dynamic>
        : <String, dynamic>{};
    final expectedCommit = expectedBuild['sourceCommit'];
    Future<bool> connected() async {
      final file = File(p.join(state, 'admin-token'));
      if (!await file.exists()) return false;
      _token = (await file.readAsString()).trim();
      try {
        final result = await get('/api/health');
        if (result['app'] != 'FarFromDesk' || result['protocol'] != 1) {
          throw StateError(
            'A different backend is running. Update it before starting FarFromDesk.',
          );
        }
        if (expectedCommit != null &&
            (result['sourceCommit'] != expectedCommit ||
                (expectedBuild['buildId'] != null &&
                    result['buildId'] != expectedBuild['buildId']))) {
          final order = compareBuilds(
            result['buildId'],
            expectedBuild['buildId'],
          );
          if (order != null && order < 0) {
            await _stopOlderBackend();
            return false;
          }
          throw StateError(
            order != null && order > 0
                ? 'A newer FarFromDesk (${result['buildId']}) is running. Open that version instead.'
                : 'Another FarFromDesk build is still running. Quit it from the menu bar or system tray, then try again.',
          );
        }
        return true;
      } on SocketException {
        return false;
      } on http.ClientException {
        return false;
      } on TimeoutException {
        return false;
      }
    }

    if (await connected()) return;
    final node =
        Platform.environment['FFD_NODE_BIN'] ??
        p.join(root, 'runtime', Platform.isWindows ? 'node.exe' : 'node');
    if (!await File(node).exists() ||
        !await File(p.join(root, 'dist', 'main.js')).exists()) {
      throw StateError(
        'The bundled backend is missing. Reinstall the FarFromDesk desktop package. Development builds need FFD_BACKEND_ROOT and FFD_NODE_BIN.',
      );
    }
    // Arguments are passed directly, never interpolated into a shell command.
    await Process.start(
      node,
      [p.join(root, 'dist', 'main.js')],
      workingDirectory: root,
      environment: {
        'WSB_STATE_DIR': state,
        'WSB_PORT': '$port',
        'FFD_PORTABLE_AGENTS': Platform.isMacOS ? '0' : '1',
        if (Platform.isMacOS)
          'WSB_DESKTOP_SYNC_BIN': p.join(root, 'native', 'desktop-sync'),
      },
      mode: ProcessStartMode.detached,
    );
    for (var i = 0; i < 60; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      if (await connected()) return;
    }
    throw StateError(
      'The local backend did not start. Check that port $port is free and the installation is complete.',
    );
  }

  Future<Map<String, dynamic>> _request(
    String path,
    Map<String, dynamic>? body,
  ) async {
    final uri = Uri.parse('http://127.0.0.1:$port$path');
    final client = http.Client();
    try {
      final request = http.Request(body == null ? 'GET' : 'POST', uri)
        ..followRedirects = false;
      request.headers.addAll({
        'Authorization': 'Bearer ${_token ?? ''}',
        'Content-Type': 'application/json',
      });
      if (body != null) request.body = jsonEncode(body);
      final response = await client
          .send(request)
          .then(http.Response.fromStream)
          .timeout(const Duration(seconds: 30));
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (response.statusCode != 200) {
        throw StateError(
          data['error']?.toString() ??
              'The local service rejected the request.',
        );
      }
      return data;
    } finally {
      client.close();
    }
  }

  @override
  Future<Map<String, dynamic>> get(String path) => _request(path, null);
  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/desktop/document' &&
        data.containsKey('_localDocumentPath')) {
      if (data['confirmed'] != true) {
        throw StateError('Confirm the reviewed file first.');
      }
      final executableDir = p.dirname(Platform.resolvedExecutable);
      final root =
          Platform.environment['FFD_BACKEND_ROOT'] ??
          (Platform.isMacOS
              ? p.normalize(p.join(executableDir, '..', 'Resources', 'backend'))
              : p.join(executableDir, 'backend'));
      final node =
          Platform.environment['FFD_NODE_BIN'] ??
          p.join(root, 'runtime', Platform.isWindows ? 'node.exe' : 'node');
      final prepared = await prepareDesktopDocument(
        node: node,
        root: root,
        state: state,
        port: port,
        path: data['_localDocumentPath'] as String,
        bindingId: data['bindingId'] as String,
        requestId: data['requestId'] as String,
      );
      return _request(path, {
        'bindingId': data['bindingId'],
        'requestId': data['requestId'],
        'confirmed': true,
        'artifactId': prepared['artifactId'],
        'caption': data['caption'] ?? '',
      });
    }
    return _request(path, data);
  }

  @override
  Future<String?> chooseFile(String label) async =>
      (await openFile(confirmButtonText: label))?.path;
  @override
  Future<Map<String, dynamic>> readDocument(String path) =>
      reviewedDocumentReference(path);

  @override
  Future<void> reportReady() async {
    // Disposable native smoke runs use a fixed marker inside their own state.
    if (Platform.environment['FFD_SMOKE_TEST'] == '1') {
      await File(p.join(state, 'smoke-ui-ready')).writeAsString('ready');
    }
  }

  @override
  Future<Map<String, dynamic>?> updateOutcome() async {
    if (!Platform.isWindows) return null;
    final file = File(p.join(state, 'app-update', 'status.json'));
    for (var i = 0; i < 120; i++) {
      Map<String, dynamic> value;
      try {
        value = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      } catch (_) {
        return null;
      }
      if (['complete', 'error'].contains(value['phase'])) {
        final receipt = File(p.join(state, 'app-update', 'shown.json'));
        final identity = '${value['attempt']}:${value['phase']}';
        if (await receipt.exists() &&
            await receipt.readAsString() == identity) {
          return null;
        }
        await receipt.writeAsString(identity, flush: true);
        return value;
      }
      if (value['phase'] != 'restarting') return null;
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    return {
      'phase': 'error',
      'message': 'The updater has not confirmed completion. Check the saved update status before retrying.',
    };
  }

  @override
  Future<bool> startupEnabled() => launchAtStartup.isEnabled();
  @override
  Future<void> setStartup(bool enabled) async {
    final ok = enabled
        ? await launchAtStartup.enable()
        : await launchAtStartup.disable();
    if (!ok) {
      throw StateError(
        'Startup registration failed. Check your operating system settings.',
      );
    }
  }
}

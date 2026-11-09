import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ffi';

import 'package:file_selector/file_selector.dart';
import 'package:http/http.dart' as http;
import 'package:launch_at_startup/launch_at_startup.dart';
import 'package:path/path.dart' as p;

import 'gateway.dart';
import 'social_share.dart';

import 'package:flutter/services.dart';

import 'startup_trace.dart';
import 'updates.dart';
import 'document_preparation.dart';
import 'local_backend_environment.dart';
import 'local_state_guard.dart';
import 'social_meta_client.dart';
import 'startup_wait.dart';

export 'local_state_guard.dart' show LocalStateUnsafe;
export 'startup_wait.dart' show BackendNotReady, PortHolder, PortState;


const _isolatedLocal = bool.fromEnvironment('FFD_ISOLATED_LOCAL');
const _localState = String.fromEnvironment('FFD_LOCAL_STATE');
const _localPort = int.fromEnvironment('FFD_LOCAL_PORT', defaultValue: 47961);
const _localCodexHome = String.fromEnvironment('FFD_LOCAL_CODEX_HOME');
/// The owner's real home, pinned at build time so the state guard does not have to
/// take $HOME's word for it. See resolveOwnerHome.
const _declaredOwnerHome = String.fromEnvironment('FFD_OWNER_HOME');

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
      port = _isolatedLocal
          ? _localPort
          : int.parse(Platform.environment['WSB_PORT'] ?? '47831');
  @override
  String get platform => Platform.operatingSystem;
  @override
  bool get localEmail => _isolatedLocal && Platform.isMacOS;
  @override
  String get computerName => Platform.localHostname;
  static String stateDirectory() {
    if (_isolatedLocal) {
      if (_localState.isEmpty) {
        throw StateError('Local test state path is missing.');
      }
      return _localState;
    }
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

  /// Separate from `update-check.json` on purpose: that file is keyed by version
  /// and platform and is discarded when either changes, so preferences kept
  /// inside it would reset themselves every time the app updated.
  File get _updatePreferencesFile =>
      File(p.join(state, 'update-preferences.json'));

  @override
  Future<UpdatePreferences> loadUpdatePreferences() async {
    try {
      final file = _updatePreferencesFile;
      if (await file.exists() && await file.length() <= 64 * 1024) {
        return UpdatePreferences.fromJson(jsonDecode(await file.readAsString()));
      }
    } catch (_) {
      // An unreadable preference file means "no choice recorded yet", never a
      // reason to fail startup.
    }
    return UpdatePreferences();
  }

  @override
  Future<void> saveUpdatePreferences(UpdatePreferences prefs) async {
    final file = _updatePreferencesFile;
    await file.parent.create(recursive: true);
    final temporary = File('${file.path}.tmp');
    await temporary.writeAsString(jsonEncode(prefs.toJson()), flush: true);
    await temporary.rename(file.path);
    // Apply immediately so the next check obeys the new cadence without a
    // restart, which is what the pane promises when someone changes it.
    final checker = await (_updateChecker ??= loadUpdateChecker());
    checker.applyPreferences(prefs);
  }

  Future<UpdateChecker> loadUpdateChecker() async {
    final abi = Abi.current();
    final arch =
        [Abi.macosArm64, Abi.linuxArm64, Abi.windowsArm64].contains(abi)
        ? 'arm64'
        : [Abi.macosX64, Abi.linuxX64, Abi.windowsX64].contains(abi)
        ? 'x64'
        : 'unsupported';
    final file = File(p.join(state, 'update-check.json'));
    final prefs = await loadUpdatePreferences();
    final checker = UpdateChecker(
      current: installedVersion,
      platform: Platform.isMacOS ? 'macos' : Platform.operatingSystem,
      architecture: arch,
      schedule: prefs.schedule,
      automatic: prefs.automatic,
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
    if (_isolatedLocal || Platform.environment['FFD_SMOKE_TEST'] == '1') {
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
  bool get canShareSocialNatively => Platform.isMacOS;

  @override
  Future<void> openSocialPlatform(String platform, String caption) =>
      _openBrowser(socialShareTarget(platform, caption).uri);

  @override
  Future<bool> exportSocialPost(SocialSharePayload post) async {
    final location = await getDirectoryPath(
      confirmButtonText: 'Export post here',
    );
    if (location == null) return false;
    // A new directory avoids overwriting any user files or previous exports.
    final folder = await Directory(location).createTemp('farfromdesk-post-');
    try {
      await File(p.join(folder.path, 'caption.txt'))
          .writeAsString(post.caption);
      for (var i = 0; i < post.images.length; i++) {
        await File(
          p.join(
            folder.path,
            'slide-${(i + 1).toString().padLeft(2, '0')}.jpg',
          ),
        ).writeAsBytes(post.images[i]);
      }
    } catch (_) {
      // Only the newly created export folder is owned by this operation.
      await folder.delete(recursive: true);
      rethrow;
    }
    return true;
  }

  @override
  Future<bool> shareSocialPost(SocialSharePayload post) async {
    if (!canShareSocialNatively) return false;
    return await const MethodChannel('farfromdesk/social-share')
            .invokeMethod<bool>('show', {
              'caption': post.caption,
              'images': post.images,
            }) ??
        false;
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
      !_isolatedLocal &&
      (Platform.isMacOS ||
          (Platform.isWindows && Abi.current() == Abi.windowsX64));
  bool _installing = false;
  @override
  Future<void> installUpdate(
    AppRelease release,
    void Function(Map<String, dynamic>) progress,
  ) async {
    if (_isolatedLocal) {
      throw StateError('Updates are disabled for FarFromDesk Local.');
    }
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
    traceStartup('waiting for older backend shutdown');
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
    if (_isolatedLocal) {
      if (!Platform.isMacOS) {
        throw StateError('Cannot verify the normal account paths for Local.');
      }
      // Never trust $HOME alone here: a launch that inherited the backend's
      // isolated environment makes the guard treat Local's own state as
      // protected data and refuse. resolveOwnerHome prefers the build-time home,
      // then the account home, and only then $HOME.
      final normalHome = resolveOwnerHome(
        state: state,
        declared: _declaredOwnerHome,
        home: Platform.environment['HOME'],
        user: Platform.environment['USER'],
      );
      // Validate metadata before creating or accessing Local's state. The
      // second check covers links added while the state directory was created.
      final protected = [
        p.join(
          normalHome,
          'Library',
          'Application Support',
          'WhatsApp Session Bridge',
        ),
        p.join(normalHome, '.farfromdesk'),
        p.join(normalHome, 'Tether Projects'),
        p.join(normalHome, '.codex'),
        p.join(normalHome, '.claude'),
        _localCodexHome,
      ];
      final runtimes = [
        p.join(normalHome, '.pyenv', 'versions'),
        p.join(normalHome, '.local', 'share', 'uv', 'python'),
      ];
      const codexExecutable =
          '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
      await assertLocalStateSafe(
        state,
        protected,
        allowedExternalFileRoots: runtimes,
        allowedCodexExecutables: [codexExecutable],
      );
      await Directory(state).create(recursive: true);
      await assertLocalStateSafe(
        state,
        protected,
        allowedExternalFileRoots: runtimes,
        allowedCodexExecutables: [codexExecutable],
      );
    }
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
      appName: _isolatedLocal ? 'FarFromDesk Local' : 'FarFromDesk',
      appPath: Platform.resolvedExecutable,
      packageName: _isolatedLocal
          ? 'com.codecylabs.farfromdesk.localtest'
          : 'com.codecylabs.farfromdesk',
    );
    final executableDir = p.dirname(Platform.resolvedExecutable);
    final root =
        (_isolatedLocal ? null : Platform.environment['FFD_BACKEND_ROOT']) ??
        (Platform.isMacOS
            ? p.normalize(p.join(executableDir, '..', 'Resources', 'backend'))
            : p.join(executableDir, 'backend'));
    traceStartup('reading backend build metadata');
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

    traceStartup('checking existing backend');
    if (await connected()) return;
    // Someone already on the port, or holding this app's data folder, is waited
    // for and adopted, never raced with a second backend: that one dies on the
    // folder lock and the owner is left with a banner blaming the installation
    // while an older copy is what is actually in the way.
    traceStartup('checking the app port');
    final PortState outcome;
    try {
      outcome = await awaitPortOrAdopt(
        healthy: _healthy,
        listening: _listening,
        holder: _portHolder,
        lockHolder: _lockHolder,
        port: '$port',
      );
    } on BackendNotReady catch (error) {
      throw BackendNotReady(
        withStuckStage(error.message, await _stuckStage()),
        holderPid: error.holderPid,
        holderIsOurs: error.holderIsOurs,
      );
    }
    if (outcome == PortState.adopted) {
      // Adoption is only real once the full check has passed, which is also what
      // stops an older build for us.
      if (await connected()) return;
    }
    final node =
        (_isolatedLocal ? null : Platform.environment['FFD_NODE_BIN']) ??
        p.join(root, 'runtime', Platform.isWindows ? 'node.exe' : 'node');
    if (!await File(node).exists() ||
        !await File(p.join(root, 'dist', 'main.js')).exists()) {
      throw StateError(
        'The bundled backend is missing. Reinstall the FarFromDesk desktop package. Development builds need FFD_BACKEND_ROOT and FFD_NODE_BIN.',
      );
    }
    traceStartup('launching bundled backend');
    // Arguments are passed directly, never interpolated into a shell command.
    await Process.start(
      node,
      [p.join(root, 'dist', 'main.js')],
      workingDirectory: root,
      includeParentEnvironment: !_isolatedLocal,
      environment: {
        if (_isolatedLocal) ...{
          ...localBackendEnvironment(state: state, codexHome: _localCodexHome),
          'FFD_MAIL_KEYCHAIN_HELPER': p.join(
            root,
            'native',
            'local-mail-keychain',
          ),
          'FFD_MAIL_APPROVAL_HELPER': p.join(
            root,
            'native',
            'local-mail-approval',
          ),
        },
        'WSB_STATE_DIR': state,
        'WSB_PORT': '$port',
        'FFD_PORTABLE_AGENTS': Platform.isMacOS ? '0' : '1',
        if (Platform.isMacOS)
          'WSB_DESKTOP_SYNC_BIN': p.join(root, 'native', 'desktop-sync'),
      },
      mode: ProcessStartMode.detached,
    );
    traceStartup('waiting for backend health');
    for (var i = 0; i < 60; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      if (await connected()) return;
    }
    // Typed, because this one is worth retrying from the UI: a backend that is
    // still settling looks like this and clears itself, unlike a refused
    // permission or a broken window call. The port was ours to start on, so the
    // wording no longer sends the owner looking for something else holding it.
    throw BackendNotReady(
      'The local backend was started but is not answering yet. This window keeps trying on its own, so press Try again in a moment.',
    );
  }

  /// A bounded health check for the port policy: a backend that is listening but
  /// wedged must not hold a start hostage through the 30 second request timeout.
  Future<bool> _healthy() async {
    final file = File(p.join(state, 'admin-token'));
    if (!await file.exists()) return false;
    try {
      _token = (await file.readAsString()).trim();
      final client = http.Client();
      try {
        final response = await client
            .get(
              Uri.parse('http://127.0.0.1:$port/api/health'),
              headers: {'Authorization': 'Bearer ${_token ?? ''}'},
            )
            .timeout(const Duration(seconds: 2));
        return response.statusCode == 200;
      } finally {
        client.close();
      }
    } catch (_) {
      return false;
    }
  }

  /// Is anything bound to the app port at all. A stopped or wedged process still
  /// accepts the connection in the kernel, which is exactly the case that needs
  /// to be told apart from a free port.
  Future<bool> _listening() async {
    for (final address in [InternetAddress.loopbackIPv4]) {
      try {
        final socket = await Socket.connect(
          address,
          port,
          timeout: const Duration(milliseconds: 800),
        );
        socket.destroy();
        return true;
      } catch (_) {
        continue;
      }
    }
    return false;
  }

  /// This app's own bundle. A process running from it is ours to end; anything
  /// else on our port never is. Matching the whole bundle path is what the
  /// installer uses too, and it covers both the app binary and the backend node
  /// process inside the same bundle, which a path fragment like "MacOS" does not.
  String get _bundle {
    return p.dirname(p.dirname(p.dirname(Platform.resolvedExecutable)));
  }

  bool _isOurs(String command) => command.trim().startsWith(_bundle);

  /// Names the process holding the port, and says whether it is this app's own
  /// backend, which is the only process the UI may offer to end.
  Future<PortHolder?> _portHolder() async {
    if (!Platform.isMacOS) return null;
    try {
      final found = await Process.run('/usr/sbin/lsof', [
        '-nP',
        '-iTCP:$port',
        '-sTCP:LISTEN',
        '-t',
      ]).timeout(const Duration(seconds: 3));
      final pid = int.tryParse(found.stdout.toString().trim().split('\n').first);
      if (pid == null) return null;
      final command = await Process.run('/bin/ps', [
        '-p',
        '$pid',
        '-o',
        'command=',
      ]).timeout(const Duration(seconds: 3));
      final line = command.stdout.toString();
      return PortHolder(pid, isOurs: _isOurs(line));
    } catch (_) {
      return null;
    }
  }

  /// Names the process holding this app's data folder, and says whether it is
  /// this app's own backend. A copy that wedged before binding its port answers
  /// nothing, so the folder lock is the only thing that gives it away.
  Future<PortHolder?> _lockHolder() async {
    if (!Platform.isMacOS) return null;
    try {
      final found = await Process.run('/usr/sbin/lsof', [
        '-nP',
        '--',
        p.join(state, 'service-lock.sqlite'),
      ]).timeout(const Duration(seconds: 3));
      for (final line in found.stdout.toString().split('\n').skip(1)) {
        final fields = line.trim().split(RegExp(r'\s+'));
        if (fields.length < 2) continue;
        final pid = int.tryParse(fields[1]);
        if (pid == null) continue;
        final command = await Process.run('/bin/ps', [
          '-p',
          '$pid',
          '-o',
          'command=',
        ]).timeout(const Duration(seconds: 3));
        if (!_isOurs(command.stdout.toString())) continue;
        return PortHolder(pid, isOurs: true, onPort: false);
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /// The startup step the stuck copy had reached, when it left one behind.
  Future<String?> _stuckStage() async {
    try {
      final file = File(p.join(state, 'startup-stage.json'));
      if (!await file.exists()) return null;
      final data = jsonDecode(await file.readAsString());
      final stage = data is Map ? data['stage'] : null;
      if (stage is! String || stage.trim().isEmpty || stage.length > 80) {
        return null;
      }
      return stage;
    } catch (_) {
      return null;
    }
  }

  Future<String?> _commandOf(int pid) async {
    try {
      final command = await Process.run('/bin/ps', [
        '-p',
        '$pid',
        '-o',
        'command=',
      ]).timeout(const Duration(seconds: 3));
      return command.stdout.toString();
    } catch (_) {
      return null;
    }
  }

  Future<bool> _alive(int pid) async {
    final command = await _commandOf(pid);
    return command != null && command.trim().isNotEmpty;
  }

  /// Ends an older copy that is still holding the port or the data folder, after
  /// confirming it is ours. Only ever called from an explicit press in the UI.
  @override
  Future<bool> stopStuckBackend(int pid) async {
    for (final who in [await _portHolder(), await _lockHolder()]) {
      if (who == null || who.pid != pid || !who.isOurs) continue;
      final signalled = Process.killPid(pid, ProcessSignal.sigterm);
      // A process wedged inside a blocking file call cannot run its own shutdown
      // handler, which is exactly the case this press exists for. It gets a
      // moment, and only a process still there and still ours is ended outright.
      unawaited(
        Future<void>.delayed(const Duration(seconds: 4), () async {
          if (!await _alive(pid)) return;
          final command = await _commandOf(pid);
          if (command == null || !_isOurs(command)) return;
          Process.killPid(pid, ProcessSignal.sigkill);
        }),
      );
      return signalled;
    }
    return false;
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
          .timeout(
            // A preference change can wait on a macOS administrator prompt.
            path == '/api/local-email' || path == '/api/preferences'
                ? const Duration(minutes: 6)
                : Duration(seconds: path.startsWith('/api/social') ? 150 : 30),
          );
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
  Future<SocialGenerator> prepareSocialGenerator() async {
    if (!_isolatedLocal) {
      throw StateError(
        'Hosted generation is only available in FarFromDesk Local.',
      );
    }
    // The local service holds the credentials and forwards to the hosted model.
    final key = _token ?? '';
    return (kind, input) => SocialMetaClient(
      base: 'http://127.0.0.1:$port/api/hosted',
      timeout: const Duration(seconds: 175),
    ).generate(kind: kind, key: key, input: input);
  }

  @override
  Future<bool> saveSocialImage(Uint8List bytes) async {
    final location = await getSaveLocation(
      suggestedName: 'social-image.jpg',
      acceptedTypeGroups: [
        const XTypeGroup(label: 'JPEG', extensions: ['jpg', 'jpeg']),
      ],
    );
    if (location == null) return false;
    await XFile.fromData(
      bytes,
      mimeType: 'image/jpeg',
      name: 'social-image.jpg',
    ).saveTo(location.path);
    return true;
  }

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

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:http/http.dart' as http;
import 'package:launch_at_startup/launch_at_startup.dart';
import 'package:path/path.dart' as p;

import 'gateway.dart';

class NativeGateway extends Gateway {
  final String state;
  final int port;
  String? _token;
  NativeGateway()
    : state = stateDirectory(),
      port = int.parse(Platform.environment['WSB_PORT'] ?? '47831');
  @override
  String get platform => Platform.operatingSystem;
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

  Future<void> start() async {
    launchAtStartup.setup(
      appName: 'FarFromDesk',
      appPath: Platform.resolvedExecutable,
      packageName: 'com.codecylabs.farfromdesk',
    );
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
    final executableDir = p.dirname(Platform.resolvedExecutable);
    final root =
        Platform.environment['FFD_BACKEND_ROOT'] ??
        (Platform.isMacOS
            ? p.normalize(p.join(executableDir, '..', 'Resources', 'backend'))
            : p.join(executableDir, 'backend'));
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
      final response = await http.Response.fromStream(
        await client.send(request),
      ).timeout(const Duration(seconds: 30));
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
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> data) =>
      _request(path, data);
  @override
  Future<String?> chooseFile(String label) async =>
      (await openFile(confirmButtonText: label))?.path;
  @override
  Future<Map<String, dynamic>> readDocument(String path) async {
    final file = File(path);
    if (await file.length() > 10 * 1024 * 1024) {
      throw StateError('Documents must be at most 10 MiB.');
    }
    return {
      'filename': p.basename(path),
      'base64': base64Encode(await file.readAsBytes()),
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

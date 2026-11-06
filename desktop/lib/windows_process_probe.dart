import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

/// Runs a console tool and returns its standard output, or null when it fails.
typedef ProbeRunner =
    Future<String?> Function(String executable, List<String> arguments);

/// Windows counterparts of the lsof and ps lookups the startup check uses on a Mac.
/// Read-only: they list sockets and processes, never signal anything.
class WindowsProcessProbe {
  WindowsProcessProbe({ProbeRunner? run, Map<String, String>? environment})
    : _run = run ?? _runConsole,
      _systemRoot =
          (environment ?? Platform.environment)['SystemRoot'] ?? r'C:\Windows';

  final ProbeRunner _run;
  final String _systemRoot;

  String get _netstat => p.windows.join(_systemRoot, 'System32', 'NETSTAT.EXE');
  String get _tasklist =>
      p.windows.join(_systemRoot, 'System32', 'tasklist.exe');
  String get _powerShell => p.windows.join(
    _systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  /// The process listening on [port] on this PC, from `netstat -ano`.
  Future<int?> listeningPid(int port) async {
    final out = await _run(_netstat, ['-ano', '-p', 'TCP']);
    final v4 = out == null ? null : listeningPidFromNetstat(out, port);
    if (v4 != null) return v4;
    final six = await _run(_netstat, ['-ano', '-p', 'TCPv6']);
    return six == null ? null : listeningPidFromNetstat(six, port);
  }

  /// The full executable path of [pid], or null when it is gone or not readable
  /// (a process of another user or an elevated one has no readable path).
  Future<String?> executablePath(int pid) async {
    final out = await _run(_powerShell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
          'Get-Process -Id $pid -ErrorAction SilentlyContinue | '
          "ForEach-Object { '{0}|{1}' -f \$_.Id, \$_.Path }",
    ]);
    return out == null ? null : processPaths(out)[pid];
  }

  /// Every running process with this image name (without ".exe") and its path.
  Future<Map<int, String>> processesNamed(String name) async {
    if (!RegExp(r'^[A-Za-z0-9_.-]{1,64}$').hasMatch(name)) return {};
    // tasklist answers in a fraction of the time PowerShell takes to start, and on
    // most launches there is nothing to look up.
    final listed = await _run(_tasklist, [
      '/FI',
      'IMAGENAME eq $name.exe',
      '/FO',
      'CSV',
      '/NH',
    ]);
    if (listed != null &&
        !listed.toLowerCase().contains('"${name.toLowerCase()}.exe"')) {
      return {};
    }
    final out = await _run(_powerShell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
          "Get-Process -Name '$name' -ErrorAction SilentlyContinue | "
          "ForEach-Object { '{0}|{1}' -f \$_.Id, \$_.Path }",
    ]);
    return out == null ? {} : processPaths(out);
  }
}

/// The owning PID of a listening TCP socket on [port] in `netstat -ano` output.
/// A listening socket is recognised by its unbound remote end (0.0.0.0:0 or [::]:0),
/// not by the state column, which Windows translates into the display language.
int? listeningPidFromNetstat(String output, int port) {
  for (final line in const LineSplitter().convert(output)) {
    final fields = line.trim().split(RegExp(r'\s+'));
    if (fields.length != 5 || fields[0].toUpperCase() != 'TCP') continue;
    final local = fields[1], remote = fields[2];
    if (!local.endsWith(':$port')) continue;
    if (remote != '0.0.0.0:0' && remote != '[::]:0') continue;
    final pid = int.tryParse(fields[4]);
    if (pid != null && pid > 0) return pid;
  }
  return null;
}

/// Parses "pid|path" lines. Lines without a path (unreadable processes) are left out.
Map<int, String> processPaths(String output) {
  final result = <int, String>{};
  for (final line in const LineSplitter().convert(output)) {
    final bar = line.indexOf('|');
    if (bar < 1) continue;
    final pid = int.tryParse(line.substring(0, bar).trim());
    final path = line.substring(bar + 1).trim();
    if (pid == null || path.isEmpty) continue;
    result[pid] = path;
  }
  return result;
}

/// True when [path] is a file inside the [folder] install (case-insensitive, as
/// Windows paths are). A sibling folder that merely starts with the same name
/// ("FarFromDesk Old") does not count.
bool windowsPathWithin(String path, String folder) {
  String clean(String s) {
    var v = s.trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      v = v.substring(1, v.length - 1);
    }
    return p.windows.normalize(v).toLowerCase();
  }

  final root = clean(folder);
  if (root.isEmpty) return false;
  return p.windows.isWithin(root, clean(path));
}

Future<String?> _runConsole(String executable, List<String> arguments) async {
  try {
    final result = await Process.run(
      executable,
      arguments,
      stdoutEncoding: const Utf8Codec(allowMalformed: true),
      stderrEncoding: const Utf8Codec(allowMalformed: true),
    ).timeout(const Duration(seconds: 6));
    if (result.exitCode != 0) return null;
    return result.stdout as String;
  } catch (_) {
    return null;
  }
}

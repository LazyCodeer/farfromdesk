import 'dart:io';

import 'package:farfromdesk/windows_process_probe.dart';
import 'package:flutter_test/flutter_test.dart';

const _netstat = '''

Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100
  TCP    127.0.0.1:47831        0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:478310       0.0.0.0:0              LISTENING       9
  TCP    127.0.0.1:52000        127.0.0.1:47831        ESTABLISHED     777
  TCP    127.0.0.1:47831        127.0.0.1:52000        ESTABLISHED     4242
''';

void main() {
  test('netstat: the listener on the port, in any display language', () {
    expect(listeningPidFromNetstat(_netstat, 47831), 4242);
    // German Windows prints ABH\u00d6REN instead of LISTENING; the unbound remote
    // end is what marks a listening socket.
    expect(
      listeningPidFromNetstat(
        '  TCP    127.0.0.1:47961    0.0.0.0:0    ABH\u00d6REN    5150\r\n',
        47961,
      ),
      5150,
    );
    expect(
      listeningPidFromNetstat(
        '  TCP    [::1]:47831    [::]:0    LISTENING    616\r\n',
        47831,
      ),
      616,
    );
    // A client connected to the port, or a longer port number, is not the holder.
    expect(listeningPidFromNetstat(_netstat, 52000), isNull);
    expect(listeningPidFromNetstat(_netstat, 4783), isNull);
    expect(listeningPidFromNetstat('', 47831), isNull);
  });

  test('process paths skip processes whose path cannot be read', () {
    expect(
      processPaths(
        '12|C:\\Users\\a\\AppData\\Local\\Programs\\FarFromDesk\\backend\\runtime\\node.exe\r\n13|\r\nbad\r\n',
      ),
      {
        12: r'C:\Users\a\AppData\Local\Programs\FarFromDesk\backend\runtime\node.exe',
      },
    );
  });

  test('ours means inside this install folder, case-insensitively', () {
    const install = r'C:\Users\a\AppData\Local\Programs\FarFromDesk';
    expect(
      windowsPathWithin(
        r'c:\users\A\appdata\local\programs\farfromdesk\backend\runtime\node.exe',
        install,
      ),
      isTrue,
    );
    expect(
      windowsPathWithin(
        '"C:\\Users\\a\\AppData\\Local\\Programs\\FarFromDesk\\FarFromDesk.exe"',
        install,
      ),
      isTrue,
    );
    expect(
      windowsPathWithin(
        r'C:\Users\a\AppData\Local\Programs\FarFromDesk Old\backend\runtime\node.exe',
        install,
      ),
      isFalse,
    );
    expect(
      windowsPathWithin(r'C:\Program Files\nodejs\node.exe', install),
      isFalse,
    );
    expect(windowsPathWithin(r'C:\x\node.exe', ''), isFalse);
  });

  test('lookups use the system tools and skip PowerShell when nothing runs', () async {
    final calls = <List<String>>[];
    Future<String?> Function(String, List<String>) runner(
      Map<String, String?> answers,
    ) => (exe, args) async {
      calls.add([exe, ...args]);
      final name = exe.split(r'\').last.toLowerCase();
      return answers[name];
    };
    var probe = WindowsProcessProbe(
      run: runner({'netstat.exe': _netstat, 'powershell.exe': '4242|C:\\A\\node.exe\r\n'}),
      environment: {'SystemRoot': r'C:\Windows'},
    );
    expect(await probe.listeningPid(47831), 4242);
    expect(calls.single.first, r'C:\Windows\System32\NETSTAT.EXE');
    expect(await probe.executablePath(4242), r'C:\A\node.exe');
    expect(await probe.executablePath(1), isNull);

    calls.clear();
    probe = WindowsProcessProbe(
      run: runner({
        'tasklist.exe': 'INFO: No tasks are running which match the specified criteria.',
        'powershell.exe': '1|C:\\A\\node.exe',
      }),
      environment: {'SystemRoot': r'C:\Windows'},
    );
    expect(await probe.processesNamed('node'), isEmpty);
    expect(calls.map((c) => c.first.split(r'\').last), ['tasklist.exe']);

    calls.clear();
    probe = WindowsProcessProbe(
      run: runner({
        'tasklist.exe': '"node.exe","77","Console","1","50,000 K"',
        'powershell.exe': '77|C:\\A\\node.exe\r\n',
      }),
      environment: {'SystemRoot': r'C:\Windows'},
    );
    expect(await probe.processesNamed('node'), {77: r'C:\A\node.exe'});
    expect(await probe.processesNamed("node'; Remove-Item x"), isEmpty);
  });

  test(
    'live, read-only: finds this test process by name and path',
    () async {
      final probe = WindowsProcessProbe();
      final self = await probe.executablePath(pid);
      expect(self, isNotNull);
      expect(self!.toLowerCase(), Platform.resolvedExecutable.toLowerCase());
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      try {
        expect(await probe.listeningPid(server.port), pid);
      } finally {
        await server.close();
      }
    },
    skip: !Platform.isWindows,
  );
}

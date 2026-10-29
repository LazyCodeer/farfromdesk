import 'dart:io';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'native_gateway.dart';
import 'app.dart';
import 'gateway.dart';
import 'startup_trace.dart';

Future<void> main(List<String> arguments) async {
  final gateway = NativeGateway();
  await launchDesktop(
    gateway: gateway,
    initializeBackend: () async {
      await gateway.start();
      // Explicit migration/install opt-in; ordinary launches never change startup.
      if (arguments.contains('--enable-login-startup')) {
        await gateway.setStartup(true);
      }
    },
  );
}

Future<void> launchDesktop({
  required Gateway gateway,
  required Future<void> Function() initializeBackend,
}) async {
  WidgetsFlutterBinding.ensureInitialized();
  traceStartup('mounting UI');
  runApp(
    FarFromDeskApp(
      gateway: gateway,
      initialize: () async {
        // Native window configuration may wait on rendering. Mount and submit
        // the first Flutter frame before awaiting any window platform calls.
        await WidgetsBinding.instance.endOfFrame;
        traceStartup('first frame submitted; initializing window');
        await windowManager.ensureInitialized();
        windowManager.addListener(_Lifecycle(gateway));
        await windowManager.setPreventClose(true);
        traceStartup('configuring window');
        await windowManager.waitUntilReadyToShow(
          const WindowOptions(
            size: Size(1160, 820),
            minimumSize: Size(900, 640),
            title: 'FarFromDesk',
          ),
        );
        // The plugin's callback is void, so await these calls directly to keep
        // errors in the startup UI instead of an unobserved async callback.
        traceStartup('showing window');
        await windowManager.show();
        await windowManager.focus();
        traceStartup('starting backend');
        await initializeBackend();
        traceStartup('backend connected');
      },
    ),
  );
}

class _Lifecycle extends WindowListener {
  final Gateway gateway;
  _Lifecycle(this.gateway);
  @override
  void onWindowClose() async {
    try {
      final s = await gateway.get('/api/status');
      if (s['preferences']?['backgroundEnabled'] != true) {
        await gateway.post('/api/shutdown', {});
      }
    } catch (_) {
      /* Never kill an unknown process or another installed service. */
    }
    await windowManager.destroy();
    exit(0);
  }
}

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'native_gateway.dart';
import 'app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  await windowManager.waitUntilReadyToShow(
    const WindowOptions(
      size: Size(1160, 820),
      minimumSize: Size(900, 640),
      title: 'FarFromDesk',
    ),
    () async {
      await windowManager.show();
      await windowManager.focus();
    },
  );
  final gateway = NativeGateway();
  runApp(FarFromDeskApp(gateway: gateway, initialize: gateway.start));
  windowManager.addListener(_Lifecycle(gateway));
  await windowManager.setPreventClose(true);
}

class _Lifecycle extends WindowListener {
  final NativeGateway gateway;
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

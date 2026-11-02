import 'package:flutter/services.dart';

/// Asks the macOS runner to keep this app (and its child processes) out of App
/// Nap while server mode is on, so timers and network work continue with the
/// lid shut.
///
/// The channel is absent on other platforms, in the web preview and in widget
/// tests; a missing implementation is not an error and the call is retried on
/// the next status poll.
class ServerModeActivity {
  static const _channel = MethodChannel('farfromdesk/server-mode');
  static bool? _active;

  static Future<void> setActive(bool active) async {
    if (_active == active) return;
    _active = active;
    try {
      await _channel.invokeMethod<void>('setActive', {'active': active});
    } catch (_) {
      _active = null;
    }
  }
}

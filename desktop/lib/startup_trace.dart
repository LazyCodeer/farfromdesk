import 'dart:io';

import 'package:flutter/foundation.dart';

/// Static stage labels only; never include paths, settings or exception bodies.
void traceStartup(String stage) {
  if (!kIsWeb && Platform.environment['FFD_SMOKE_TEST'] == '1') {
    debugPrint('Native startup: $stage');
  }
}

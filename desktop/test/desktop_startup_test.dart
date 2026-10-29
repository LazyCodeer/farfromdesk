import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/main.dart' as desktop;
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';
import 'package:window_manager/window_manager.dart';

class StartupGateway extends PreviewGateway {
  StartupGateway() : super(fixture: 'connected');
  final stages = <String>[];
  @override
  Future<bool> startupEnabled() async {
    stages.add('login');
    return false;
  }

  @override
  Future<void> reportReady() async {
    stages.add('ready');
  }
}

void main() {
  const channel = MethodChannel('window_manager');
  testWidgets(
    'native window completion can depend on an already mounted Flutter frame',
    (tester) async {
      tester.view.physicalSize = const Size(1160, 900);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(
        tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
      );
      final window = Completer<void>();
      final api = StartupGateway();
      final methods = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        methods.add(call.method);
        if (call.method == 'ensureInitialized') await window.future;
        return false;
      });
      addTearDown(() {
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        );
        for (final listener in windowManager.listeners) {
          windowManager.removeListener(listener);
        }
      });
      final launch = desktop.launchDesktop(
        gateway: api,
        initializeBackend: () async {
          api.stages.add('backend');
        },
      );
      await tester.pump();
      await tester.pump();
      final mountedBeforeWindow = find
          .byType(FarFromDeskApp)
          .evaluate()
          .isNotEmpty;
      final backendBeforeWindow = api.stages.contains('backend');
      window.complete();
      await launch;
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      expect(
        mountedBeforeWindow,
        isTrue,
        reason: 'window platform calls must not gate the first Flutter frame',
      );
      expect(backendBeforeWindow, isFalse);
      expect(api.stages, ['backend', 'login', 'ready']);
      expect(
        methods,
        containsAllInOrder([
          'ensureInitialized',
          'waitUntilReadyToShow',
          'show',
          'focus',
        ]),
      );
      expect(tester.takeException(), isNull);
    },
  );
  for (final failure in ['ensureInitialized', 'focus']) {
    testWidgets(
      'a $failure error is rendered and cannot claim startup success',
      (tester) async {
        tester.view.physicalSize = const Size(1160, 900);
        tester.view.devicePixelRatio = 1;
        tester.platformDispatcher.accessibilityFeaturesTestValue =
            const FakeAccessibilityFeatures(disableAnimations: true);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(
          tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
        );
        final api = StartupGateway();
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            if (call.method == failure) {
              throw PlatformException(
                code: 'window_error',
                message: 'Synthetic window failure',
              );
            }
            return false;
          },
        );
        addTearDown(() {
          tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          );
          for (final listener in windowManager.listeners) {
            windowManager.removeListener(listener);
          }
        });
        await desktop.launchDesktop(
          gateway: api,
          initializeBackend: () async {
            api.stages.add('backend');
          },
        );
        await tester.pumpAndSettle();
        expect(find.textContaining('Synthetic window failure'), findsWidgets);
        expect(api.stages, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}

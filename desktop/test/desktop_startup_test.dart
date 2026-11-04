import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/main.dart' as desktop;
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/native_gateway.dart';
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

/// A backend that answers only once [down] is cleared, so a launch can be made to
/// fail and then recover exactly as a busy or half-started backend does.
class OutageGateway extends StartupGateway {
  bool down = true;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    // Only the status/health path fails, so the assertions below see the startup
    // error alone and not a pane loader reporting the same outage.
    if (down && path == '/api/status') {
      throw BackendNotReady(
        'The local backend was started but is not answering yet. This window keeps trying on its own, so press Try again in a moment.',
      );
    }
    return super.get(path);
  }
}


/// An older copy that holds the app data folder and never answers, plus the one
/// press that ends it: pressing has to actually stop that process and start.
class StuckCopyGateway extends StartupGateway {
  bool stuck = true;
  int? stopped;
  @override
  Future<bool> stopStuckBackend(int pid) async {
    stopped = pid;
    stuck = false;
    return true;
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
  testWidgets('a slow launch recovers by itself instead of leaving a backend banner', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    final api = OutageGateway();
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async => false);
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
        if (api.down) {
          throw BackendNotReady(
            'The local backend was started but is not answering yet. This window keeps trying on its own, so press Try again in a moment.',
          );
        }
        api.stages.add('backend');
      },
    );
    // First attempts fail. Inside the grace window this is a starting app, not a
    // broken install, so no error is claimed yet.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.textContaining('not answering yet'), findsNothing);
    expect(api.stages, isNot(contains('ready')));
    // The backend comes up. Nothing is tapped and no tab is switched.
    api.down = false;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.textContaining('not answering yet'), findsNothing);
    expect(api.stages, contains('ready'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a backend that stays down is reported, then clears itself when it answers', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    final api = OutageGateway();
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async => false);
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
        if (api.down) {
          throw BackendNotReady(
            'The local backend was started but is not answering yet. This window keeps trying on its own, so press Try again in a moment.',
          );
        }
        api.stages.add('backend');
      },
    );
    // Retries exhausted the grace window, so the real failure is shown.
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(seconds: 3));
    }
    expect(find.textContaining('not answering yet'), findsWidgets);
    // The backend answers later. The retry clears it with no owner action.
    api.down = false;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.textContaining('not answering yet'), findsNothing);
    expect(api.stages, contains('ready'));
    await tester.pumpWidget(const SizedBox());
  });

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

  /// The Local state guard runs before the backend is started, and a leftover
  /// symlink used to stop the app with a sentence that named no path and no
  /// check. It must now say what is wrong, and still recover on its own when the
  /// file goes away, because that is what a running session cleaning up looks
  /// like from here.
  testWidgets('a Local state problem is named at once and still recovers', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    final api = StartupGateway();
    var unsafe = true;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async => false);
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
        if (unsafe) {
          throw LocalStateUnsafe(
            'Local link escapes its permitted paths: /tmp/state/home/.codex/tmp/applypatch -> /tmp/gone',
          );
        }
        api.stages.add('backend');
      },
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.textContaining('escapes its permitted paths'), findsWidgets);
    expect(find.textContaining('backend was not started'), findsNothing);
    // No press: the retry picks the state folder up once the file is gone.
    unsafe = false;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.textContaining('escapes its permitted paths'), findsNothing);
    expect(api.stages, contains('ready'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a named stuck copy is reported at once and one press clears it', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    final api = StuckCopyGateway();
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async => false);
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
        if (api.stuck) {
          throw BackendNotReady(
            'FarFromDesk is still running in the background (pid 87387) but it never finished starting, and it is holding this app data folder. This window keeps trying on its own; to start now, quit that copy.',
            holderPid: 87387,
            holderIsOurs: true,
          );
        }
        api.stages.add('backend');
      },
    );
    // Named, so it is on screen in the first frame instead of after the grace
    // window that exists for an unnamed slow launch.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.textContaining('87387'), findsWidgets);
    expect(find.textContaining('never finished starting'), findsWidgets);
    expect(find.text('Quit the older copy and start'), findsOneWidget);
    await tester.tap(find.text('Quit the older copy and start'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(api.stopped, 87387);
    expect(api.stages, contains('ready'));
    expect(find.textContaining('never finished starting'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}

import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUpAll(() async {
    final loader = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await loader.load();
  });
  void size(WidgetTester tester) {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
  }

  testWidgets(
    'Inbox keeps the cleanup panel behind its own control and dialog',
    (tester) async {
      size(tester);
      final api = PreviewGateway(fixture: 'activity', screen: 'activity');
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      // The funnel that used to open the filter menu now opens request cleanup.
      final cleanup = find.byKey(const ValueKey('inbox-cleanup-settings'));
      expect(cleanup, findsOneWidget);
      await tester.tap(cleanup);
      await tester.pumpAndSettle();
      expect(find.text('Auto-close stale requests'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('request-cleanup-enabled')));
      await tester.pumpAndSettle();
      expect(find.text('Enable automatic request cleanup?'), findsOneWidget);
      await tester.tap(find.text('Cancel').last);
      await tester.pumpAndSettle();
      expect(api.calls, isNot(contains('/api/request-cleanup')));
      await tester.tap(find.byKey(const ValueKey('request-cleanup-enabled')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm').last);
      await tester.pumpAndSettle();
      expect(api.calls, contains('/api/request-cleanup'));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

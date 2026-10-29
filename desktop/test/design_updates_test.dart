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
    'Inbox retains the filter and moves cleanup into its own dialog',
    (tester) async {
      size(tester);
      final api = PreviewGateway(fixture: 'activity', screen: 'activity');
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      final filter = find.byKey(const ValueKey('activity-filter-group'));
      expect(filter, findsOneWidget);
      await tester.tap(filter);
      await tester.pumpAndSettle();
      expect(find.text('Waiting'), findsOneWidget);
      expect(find.text('Needs review'), findsOneWidget);
      await tester.tap(find.text('Waiting'));
      await tester.pumpAndSettle();
      expect(find.text('Waiting'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('inbox-cleanup-settings')));
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

  testWidgets(
    'Items search filters live data and shows a clear no-results state',
    (tester) async {
      size(tester);
      await tester.pumpWidget(
        FarFromDeskApp(
          gateway: PreviewGateway(fixture: 'activity', screen: 'items'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Approve the build for the hero fix'), findsOneWidget);
      expect(find.text('Draft release notes'), findsOneWidget);
      final search = find.byWidgetPredicate(
        (w) =>
            w is TextField &&
            w.decoration?.hintText == 'Search items or sessions',
      );
      await tester.enterText(search, 'hero');
      await tester.pumpAndSettle();
      expect(find.text('Approve the build for the hero fix'), findsOneWidget);
      expect(find.text('Fix hero spacing on mobile'), findsOneWidget);
      expect(find.text('Draft release notes'), findsNothing);
      await tester.enterText(search, 'no matching item');
      await tester.pumpAndSettle();
      expect(
        find.text('No matching items. Try another search.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Items retains the Brain-off empty state', (tester) async {
    size(tester);
    await tester.pumpWidget(
      FarFromDeskApp(
        gateway: PreviewGateway(fixture: 'connected', screen: 'items'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('No items yet'), findsOneWidget);
    expect(
      find.text('Turn on the brain to keep an item list.'),
      findsOneWidget,
    );
    expect(find.text('Open Brain'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}

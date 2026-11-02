import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';
import 'package:farfromdesk/social_preview.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  void size(WidgetTester tester) {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets(
    'offline preview opens on an empty week without a provider call',
    (tester) async {
      size(tester);
      final api = PreviewGateway(fixture: 'connected', screen: 'social');
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('social-preview')), findsOneWidget);
      expect(find.text('No posts yet'), findsOneWidget);
      expect(find.text('0 drafts'), findsNWidgets(7));
      expect(find.text('Publish'), findsNothing);
      expect(find.byType(TextField), findsNothing);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Generate'))
            .onPressed,
        isNull,
      );
      expect(api.calls, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('preview tabs and week navigation do not create drafts', (
    tester,
  ) async {
    size(tester);
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: SocialPreview())),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Next week'));
    await tester.pumpAndSettle();
    expect(find.text('0 drafts'), findsNWidgets(7));
    for (final tab in ['drafts', 'ideas', 'brand', 'templates', 'calendar']) {
      await tester.tap(find.byKey(Key('social-tab-$tab')));
      await tester.pumpAndSettle();
    }
    expect(find.text('No posts yet'), findsOneWidget);
    expect(find.text('Publish'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

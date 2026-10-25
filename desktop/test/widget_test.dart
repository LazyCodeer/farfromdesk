import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

void main() {
  setUpAll(() async {
    final font = FontLoader('DMSans')
      ..addFont(rootBundle.load('assets/DMSans.ttf'));
    await font.load();
  });
  void size(WidgetTester tester) {
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets(
    'Build-41 shell and pairing consent preserve the existing design and authorization',
    (tester) async {
      size(tester);
      final api = PreviewGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.text('FarFromDesk / Home'), findsOneWidget);
      expect(find.text('Pair your phone'), findsOneWidget);
      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
      expect(
        Theme.of(tester.element(find.byWidget(scaffold)))
            .scaffoldBackgroundColor,
        const Color(0xff17181d),
      );
      await tester.tap(find.text('Connect WhatsApp'));
      await tester.pumpAndSettle();
      expect(
        find.text('Allow background access and connect WhatsApp?'),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);
      await tester.tap(find.text('Connect WhatsApp'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Allow and connect'));
      await tester.pumpAndSettle();
      expect(
        api.calls,
        containsAllInOrder(['/api/preferences', '/api/connect']),
      );
      await tester.ensureVisible(find.text('Use existing session'));
      await tester.tap(find.text('Use existing session'));
      await tester.pumpAndSettle();
      expect(find.text('63 saved chats'), findsOneWidget);
      await tester.enterText(find.byType(TextField).first, 'Website');
      await tester.pumpAndSettle();
      expect(find.text('1 saved chats'), findsOneWidget);
      await tester.tap(find.text('Website redesign'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Use selected session'));
      await tester.tap(find.text('Use selected session'));
      await tester.pumpAndSettle();
      expect(find.textContaining('codex-sample-0'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.calls, isNot(contains('/api/master-select')));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Connected Home, master dialog, Activity filters and Settings match the shared screen structure',
    (tester) async {
      size(tester);
      await tester.pumpWidget(
        FarFromDeskApp(gateway: PreviewGateway(fixture: 'connected')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Where should replies appear?'), findsOneWidget);
      await tester.ensureVisible(find.text('Change platform or master'));
      await tester.tap(find.text('Change platform or master'));
      await tester.pumpAndSettle();
      expect(find.text('Choose an existing session'), findsOneWidget);
      await tester.tap(find.text('Create new session'));
      await tester.pumpAndSettle();
      expect(find.text('Automatic'), findsOneWidget);
      expect(find.text('FarFromDesk · Codex CLI'), findsOneWidget);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Activity'));
      await tester.pumpAndSettle();
      expect(find.text('Request history'), findsOneWidget);
      expect(find.text('Select eligible'), findsOneWidget);
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
      expect(find.text('Run in the background'), findsOneWidget);
      expect(find.text('Open at login'), findsOneWidget);
      expect(find.text('Coding apps'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Minimum native window has no layout overflow on all three screens',
    (tester) async {
      tester.view.physicalSize = const Size(900, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        FarFromDeskApp(gateway: PreviewGateway(fixture: 'activity')),
      );
      await tester.pumpAndSettle();
      for (final page in ['Activity', 'Settings', 'Home']) {
        await tester.tap(find.byTooltip(page));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox());
    },
  );
}

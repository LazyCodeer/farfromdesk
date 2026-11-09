import 'dart:async';

import 'package:farfromdesk/preview.dart';
import 'package:farfromdesk/social_generate_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> pairedStatus() => {
  'channelChosen': true,
  'controlChannel': 'whatsapp',
  'whatsapp': {'status': 'connected', 'phoneNumber': '+15551234567'},
  'bindings': [
    {
      'id': 'a',
      'name': 'Alpha',
      'provider': 'codex',
      'native_id': 'native-a',
      'enabled': 1,
    },
    {
      'id': 'b',
      'name': 'Beta',
      'provider': 'claude',
      'native_id': 'native-b',
      'enabled': true,
    },
  ],
};

class DispatchGateway extends PreviewGateway {
  DispatchGateway() : super(fixture: 'connected');
  Map<String, dynamic> current = pairedStatus();
  final submissions = <Map<String, dynamic>>[];
  Map<String, dynamic> result = {
    'requestId': 'request-123',
    'status': 'queued',
  };
  bool failPost = false;
  Completer<void>? pending;
  @override
  Future<Map<String, dynamic>> get(String path) async =>
      path == '/api/status' ? current : super.get(path);
  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    expect(path, '/api/social/dispatch');
    submissions.add(Map<String, dynamic>.from(data));
    if (pending != null) await pending!.future;
    if (failPost) throw StateError('synthetic lost response');
    return result;
  }
}

void main() {
  Future<void> open(WidgetTester tester, DispatchGateway api) async {
    tester.view.physicalSize = const Size(1400, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: SocialGenerateDialog(gateway: api)),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> choose(
    WidgetTester tester, {
    String session = 'Alpha · Codex · native-a',
  }) async {
    await tester.tap(find.byKey(const Key('social-session-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(session).last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextField).first,
      'Draft an educational post.',
    );
    await tester.tap(find.text('Instagram'));
    await tester.pumpAndSettle();
  }

  testWidgets('explicit selection queues exactly one stable attempt', (
    tester,
  ) async {
    final api = DispatchGateway()..pending = Completer<void>();
    await open(tester, api);
    expect(find.text('Select a session'), findsOneWidget);
    await tester.tap(find.text('Send to session'));
    await tester.pumpAndSettle();
    expect(api.submissions, isEmpty);
    expect(
      find.textContaining('Choose a session and platform'),
      findsOneWidget,
    );
    await choose(tester);
    await tester.tap(find.text('LinkedIn'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send to session'));
    await tester.pump();
    expect(api.submissions, hasLength(1));
    final payload = api.submissions.single;
    expect(payload['bindingId'], 'a');
    expect(payload['imageProvider'], 'local');
    expect(payload['prompt'], 'Draft an educational post.');
    expect(payload['platforms'], ['instagram', 'linkedin']);
    expect(
      payload['eventId'],
      matches(
        RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        ),
      ),
    );
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Sending…'))
          .onPressed,
      isNull,
    );
    await tester.pump(const Duration(seconds: 1));
    expect(api.submissions.single['eventId'], payload['eventId']);
    api.pending!.complete();
    await tester.pumpAndSettle();
    expect(find.textContaining('Request queued.'), findsOneWidget);
    expect(find.textContaining('Request: request-123'), findsOneWidget);
    expect(find.textContaining('Request completed'), findsNothing);
    expect(api.submissions, hasLength(1));
    expect(tester.takeException(), isNull);
  });

  testWidgets('changed session or owner blocks submission before POST', (
    tester,
  ) async {
    final api = DispatchGateway();
    await open(tester, api);
    await choose(tester);
    api.current = pairedStatus();
    (api.current['bindings'] as List).first['native_id'] = 'different-native';
    await tester.tap(find.text('Send to session'));
    await tester.pumpAndSettle();
    expect(api.submissions, isEmpty);
    expect(
      find.textContaining('session or owner chat changed'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('unknown POST outcome stays visible without automatic retry', (
    tester,
  ) async {
    final api = DispatchGateway()..failPost = true;
    await open(tester, api);
    await choose(tester, session: 'Beta · Claude · native-b');
    await tester.tap(find.text('Send to session'));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('submission could not be confirmed'),
      findsOneWidget,
    );
    expect(find.textContaining('Attempt:'), findsOneWidget);
    expect(find.text('Send to session'), findsNothing);
    expect(api.submissions, hasLength(1));
    expect(api.submissions.single['bindingId'], 'b');
    expect(tester.takeException(), isNull);
  });

  testWidgets('missing owner or session disables submission', (tester) async {
    final api = DispatchGateway();
    api.current['channelChosen'] = false;
    api.current['bindings'] = [];
    await open(tester, api);
    expect(
      find.text('Connect a paired owner chat before sending.'),
      findsOneWidget,
    );
    expect(
      find.text(
        'No connected sessions are available. Connect a session first.',
      ),
      findsOneWidget,
    );
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Send to session'),
          )
          .onPressed,
      isNull,
    );
    expect(api.submissions, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'completed response is distinct and custom platform is included',
    (tester) async {
      final api = DispatchGateway()
        ..result = {'requestId': 'request-456', 'status': 'completed'};
      await open(tester, api);
      await choose(tester);
      await tester.tap(find.text('Other'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'Example network');
      await tester.tap(find.text('Send to session'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Request completed. Check Drafts'),
        findsOneWidget,
      );
      expect(api.submissions.single['platforms'], ['instagram', 'other']);
      expect(
        api.submissions.single['prompt'],
        'Draft an educational post.\n\nOther platform: Example network',
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('hosted images say when unavailable, then submit only the provider ID', (tester) async {
    final api = DispatchGateway();
    await open(tester, api);
    await choose(tester);
    await tester.tap(find.byKey(const Key('social-image-provider')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('FarFromDesk hosted').last);
    await tester.pumpAndSettle();
    expect(find.textContaining('hosted image model is unavailable'), findsOneWidget);
    await tester.tap(find.text('Send to session'));
    await tester.pumpAndSettle();
    expect(api.submissions, isEmpty);
    api.current['metaBrain'] = {'configured': true};
    // Reopen to refresh status without touching credentials.
    await tester.pumpWidget(const SizedBox());
    await open(tester, api);
    await choose(tester);
    await tester.tap(find.byKey(const Key('social-image-provider')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('FarFromDesk hosted').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send to session'));
    await tester.pumpAndSettle();
    expect(api.submissions.single['imageProvider'], 'meta');
    expect(api.submissions.single.containsKey('key'), isFalse);
    expect(tester.takeException(), isNull);
  });

}

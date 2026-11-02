import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/gateway.dart';
import 'package:farfromdesk/local_email_screen.dart';

class FakeGateway extends Gateway {
  final calls = <Map<String, dynamic>>[];
  bool consent = false, configured = false;
  @override
  String get platform => 'macos';
  @override
  Future<Map<String, dynamic>> get(String path) async => {
    'available': true,
    'cloudConsent': consent,
    'accounts': configured
        ? [
            {
              'id': 'account',
              'address': 'owner@example.test',
              'status': 'configured',
            },
          ]
        : [],
  };
  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    calls.add(data);
    switch (data['action']) {
      case 'configure':
        configured = true;
        return {};
      case 'consent':
        consent = data['enabled'];
        return {};
      case 'inbox':
        return {'messages': []};
      default:
        return {};
    }
  }

  @override
  Future<String?> chooseFile(String label) async => null;
  @override
  Future<Map<String, dynamic>> readDocument(String path) async => {};
  @override
  Future<bool> startupEnabled() async => false;
  @override
  Future<void> setStartup(bool enabled) async {}
}

void main() {
  testWidgets('account setup and separate model consent are explicit', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = FakeGateway();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: LocalEmailScreen(gateway: api)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Gmail app passwords'), findsNothing);
    expect(api.consent, false);
    await tester.tap(find.text('Connect account'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Gmail app passwords'), findsOneWidget);
    await tester.enterText(
      find.widgetWithText(TextField, 'Email address'),
      'owner@example.test',
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'IMAP app password'),
      'synthetic',
    );
    await tester.ensureVisible(
      find.widgetWithText(TextField, 'SMTP app password'),
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'SMTP app password'),
      'synthetic',
    );
    await tester.ensureVisible(find.text('Save account'));
    await tester.tap(find.text('Save account'));
    await tester.pumpAndSettle();
    expect(api.configured, true);
    expect(api.consent, false);
    expect(find.textContaining('saved, unverified'), findsOneWidget);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(api.consent, true);
  });
}

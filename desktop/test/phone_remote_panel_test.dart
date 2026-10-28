import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/phone_remote_panel.dart';
import 'remote_desktop_test.dart' show FakeRemote;

class FakePhone extends FakeRemote {
  @override
  Future<Map<String, dynamic>> get(String path) async => {
    'supported': true, 'passwordSet': passwordSet, 'running': false,
    'addresses': [{'name': 'Wi-Fi', 'address': '192.168.1.5'}],
  };
  @override
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> data) async {
    if (data['action'] == 'check') {
      commands.add(data);
      return {'permissions': {'accessibility': true, 'screen_recording': true}};
    }
    return super.post(path, data);
  }
}

class RetryPhone extends FakePhone {
  @override
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> data) async =>
      data['action'] == 'password' ? throw StateError('WAIT_BEFORE_RETRY') : super.post(path, data);
}

void main() {
  testWidgets('a refused password save shows the Mac\'s reason, not the permissions hint', (tester) async {
    await tester.pumpWidget(MaterialApp(home: PhoneRemotePage(gateway: RetryPhone())));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('phone-password')), 'phone test password');
    await tester.enterText(find.byKey(const Key('phone-confirmation')), 'phone test password');
    await tester.ensureVisible(find.text('Save password'));
    await tester.tap(find.text('Save password')); await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Too many tries. Wait a moment, then try again.'), -200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Too many tries. Wait a moment, then try again.'), findsOneWidget);
    expect(find.textContaining('Check permissions and the selected window'), findsNothing);
  });
  testWidgets('phone preview requires matching password, confirmed permissions and target; leaving does not stop', (tester) async {
    final api = FakePhone();
    await tester.pumpWidget(MaterialApp(home: PhoneRemotePage(gateway: api)));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('phone-password')), 'phone test password');
    await tester.enterText(find.byKey(const Key('phone-confirmation')), 'mismatch');
    await tester.ensureVisible(find.text('Save password'));
    await tester.tap(find.text('Save password')); await tester.pumpAndSettle();
    expect(api.commands.where((c) => c['action'] == 'password'), isEmpty);
    await tester.enterText(find.byKey(const Key('phone-confirmation')), 'phone test password');
    await tester.tap(find.text('Save password')); await tester.pumpAndSettle();
    expect(api.passwordSet, isTrue);
    await tester.scrollUntilVisible(find.byKey(const Key('phone-password')), -200, scrollable: find.byType(Scrollable).first);
    expect(tester.widget<TextField>(find.byKey(const Key('phone-password'))).controller!.text, isEmpty);
    await tester.scrollUntilVisible(find.byTooltip('Check permissions'), 200, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.byTooltip('Check permissions')); await tester.pumpAndSettle();
    expect(find.text('Accessibility: Allowed'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Start phone preview'), 300, scrollable: find.byType(Scrollable).first);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Start phone preview')).onPressed, isNull);
    await tester.pumpWidget(const SizedBox()); await tester.pumpAndSettle();
    expect(api.commands.where((c) => c['action'] == 'stop'), isEmpty);
  });
}

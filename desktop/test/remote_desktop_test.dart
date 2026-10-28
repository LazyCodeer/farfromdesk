import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/gateway.dart';
import 'package:farfromdesk/remote_desktop.dart';

class FakeRemote extends Gateway {
  @override
  String get platform => 'macos';
  @override
  Future<String?> chooseFile(String label) async => null;
  @override
  Future<Map<String, dynamic>> readDocument(String path) async => {};
  @override
  Future<bool> startupEnabled() async => false;
  @override
  Future<void> setStartup(bool enabled) async {}

  final commands = <Map<String, dynamic>>[];
  bool passwordSet = false;
  @override
  Future<Map<String, dynamic>> get(String path) async => {
    'passwordSet': passwordSet,
    'enabled': false,
    'transportConfigured': false,
    'message': 'Local test only',
  };
  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    commands.add(Map.of(data));
    if (data['action'] == 'password') passwordSet = true;
    return get(path);
  }
}

void main() {
  testWidgets(
    'password configured inside app, cleared after saving, no configured transport means no capture',
    (tester) async {
      final gateway = FakeRemote();
      await tester.pumpWidget(
        MaterialApp(home: RemoteDesktopPage(gateway: gateway)),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('remote-password')),
        'test-only long password',
      );
      await tester.enterText(
        find.byKey(const Key('remote-password-confirm')),
        'test-only long password',
      );
      await tester.tap(find.text('Save password'));
      await tester.pumpAndSettle();
      expect(
        gateway.commands.where((c) => c['action'] == 'password').length,
        1,
      );
      expect(find.text('Password saved'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('remote-password')))
            .controller!
            .text,
        isEmpty,
      );
      await tester.scrollUntilVisible(find.text('Choose screen and start local video test'), 200, scrollable: find.byType(Scrollable).first);
      final start = tester.widget<FilledButton>(
        find.widgetWithText(
          FilledButton,
          'Choose screen and start local video test',
        ),
      );
      expect(start.onPressed, isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );
}

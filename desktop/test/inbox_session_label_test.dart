import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

class SessionLabelGateway extends PreviewGateway {
  SessionLabelGateway() : super(fixture: 'activity', screen: 'activity');
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['bindings'] = [
      {
        'id': 'desktop',
        'name': 'Design',
        'alias': 'desktop',
        'provider': 'claude',
        'mode': 'desktop',
        'executionMode': 'desktop',
      },
      {
        'id': 'cli',
        'name': 'Code',
        'alias': 'cli',
        'provider': 'codex',
        'mode': 'desktop',
        'executionMode': 'cli',
      },
      {
        'id': 'unknown',
        'name': 'Legacy',
        'alias': 'unknown',
        'provider': 'claude',
        'mode': 'desktop',
      },
    ];
    data['pendingJobs'] = [
      {
        'id': 'wa:desktop',
        'binding_id': 'desktop',
        'status': 'submitted',
        'created_at': 100,
        'preview': 'Desktop message',
      },
      {
        'id': 'wa:cli',
        'binding_id': 'cli',
        'status': 'submitted',
        'created_at': 200,
        'preview': 'CLI message',
      },
      {
        'id': 'wa:unknown',
        'binding_id': 'unknown',
        'status': 'submitted',
        'created_at': 300,
        'preview': 'Legacy message',
      },
    ];
    data['jobs'] = [];
    return data;
  }
}

void main() {
  setUpAll(() async {
    final font = FontLoader('Onest')
      ..addFont(rootBundle.load('assets/Onest-Regular.ttf'))
      ..addFont(rootBundle.load('assets/Onest-Medium.ttf'))
      ..addFont(rootBundle.load('assets/Onest-SemiBold.ttf'))
      ..addFont(rootBundle.load('assets/Onest-Bold.ttf'));
    await font.load();
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
  });
  testWidgets('Inbox distinguishes Desktop, CLI and unknown session modes', (
    tester,
  ) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(FarFromDeskApp(gateway: SessionLabelGateway()));
    await tester.pumpAndSettle();
    Finder label(String id, String text) => find.descendant(
      of: find.byKey(ValueKey('inbox-session-$id')),
      matching: find.text(text),
    );
    expect(label('desktop', 'Claude Desktop'), findsOneWidget);
    expect(label('cli', 'Codex CLI'), findsOneWidget);
    expect(label('unknown', 'Claude session'), findsOneWidget);
    expect(label('unknown', 'Claude CLI'), findsNothing);
    expect(label('unknown', 'Claude Desktop'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

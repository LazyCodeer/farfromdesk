import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/deepseek_panel.dart';
import 'package:farfromdesk/preview.dart';

/// Where the sessions are reached from: the coordinators that run them, not Settings.
class SessionsGateway extends PreviewGateway {
  SessionsGateway() : super(fixture: 'connected');

  Map<String, dynamic> get _view => {
    'configured': true,
    'route': 'azure-deepseek',
    'model': 'DeepSeek-V4.1-Flash',
    'keySource': 'credentials',
    'folders': ['/sample/work'],
    'folder': '/sample/work',
    'activeLabel': 'default',
    'sessions': [
      {
        'label': 'default',
        'sessionId': 'session-abc123',
        'active': true,
        'busy': false,
        'waiting': 0,
        'pending': 0,
      },
    ],
    'inboxLabel': 'default',
    'inbox': <Object>[],
    'workspaces': [
      {
        'folder': '/sample/work',
        'activeLabel': 'default',
        'sessions': [
          {
            'label': 'default',
            'sessionId': 'session-abc123',
            'active': true,
            'busy': false,
            'waiting': 0,
            'pending': 0,
          },
        ],
        'inboxLabel': 'default',
        'inbox': <Object>[],
      },
    ],
  };

  @override
  Future<Map<String, dynamic>> get(String path) async =>
      path == '/api/deepseek' ? _view : super.get(path);
}

void main() {
  Future<void> pumpApp(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1600, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(FarFromDeskApp(gateway: SessionsGateway()));
    await tester.pumpAndSettle();
  }

  testWidgets('the coordinator card opens the sessions, and Settings does not '
      'offer them', (tester) async {
    await pumpApp(tester);

    // Settings is for what the owner configures; the sessions are not there.
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(
      find.text('DeepSeek Harness'),
      findsNothing,
      reason: 'the sessions are a surface, not a setting',
    );

    await tester.tap(find.text('Overview'));
    await tester.pumpAndSettle();
    expect(find.text('Sessions'), findsOneWidget);
    await tester.ensureVisible(find.text('Sessions'));
    await tester.tap(find.text('Sessions'));
    await tester.pumpAndSettle();

    expect(find.byType(DeepSeekPanel), findsOneWidget);
    expect(find.text('DeepSeek sessions'), findsOneWidget);
    expect(find.textContaining('Runs azure-deepseek'), findsOneWidget);
    expect(find.textContaining('Active session: default'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
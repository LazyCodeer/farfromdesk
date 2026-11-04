import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/deepseek_panel.dart';

/// The DeepSeek page reads one route and writes to it; a panel that only looks
/// right is not enough, because the owner has to be able to switch a session and
/// leave a message from here.
void main() {
  Map<String, dynamic> view({
    String active = 'default',
    List<String> labels = const ['default', 'research'],
    List<Map<String, dynamic>> inbox = const [],
  }) => {
    'route': 'azure-deepseek',
    'model': 'DeepSeek-V4.1-Flash',
    'keySource': 'credentials',
    'hasStoredKey': false,
    'configured': true,
    'folder': '/tmp/work',
    'folders': ['/tmp/work'],
    'activeLabel': active,
    'sessions': [
      for (final label in labels)
        {
          'label': label,
          'sessionId': 'session-$label-1234567890',
          'active': label == active,
          'busy': false,
          'waiting': 0,
          'pending': 0,
        },
    ],
    'inboxLabel': active,
    'inbox': inbox,
  };

  Future<void> pump(WidgetTester tester, List<Map<String, dynamic>> posts, {Map<String, dynamic>? first}) async {
    tester.view.physicalSize = const Size(1400, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    var current = first ?? view();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DeepSeekPanel.calls(
            get: (path) async => current,
            post: (path, data) async {
              posts.add({'path': path, ...data});
              // The route answers with the view after the action, which is what
              // the panel then draws.
              current = switch (data['action']) {
                'use' => view(active: '${data['label']}'),
                'new' => view(active: '${data['label']}', labels: ['default', '${data['label']}']),
                'send' => view(
                  inbox: [
                    {'state': 'prepared', 'from': 'the app', 'text': '${data['text']}'},
                  ],
                ),
                _ => view(),
              };
              return current;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('shows the provider, the workspace and the sessions inside it', (tester) async {
    await pump(tester, []);
    expect(find.textContaining('Runs azure-deepseek with DeepSeek-V4.1-Flash'), findsOneWidget);
    expect(find.text('tmp/work'), findsOneWidget, reason: 'the chip shows the last two path parts');
    expect(find.text('/tmp/work'), findsOneWidget);
    expect(find.text('default'), findsOneWidget);
    expect(find.text('research'), findsOneWidget);
    expect(find.textContaining('Active session: default'), findsOneWidget);
  });

  testWidgets('switching a session posts the label and draws the new active one', (tester) async {
    final posts = <Map<String, dynamic>>[];
    await pump(tester, posts);
    // Only the session that is not active offers "Use".
    await tester.tap(find.text('Use'));
    await tester.pumpAndSettle();
    expect(posts, [
      {'path': '/api/deepseek', 'action': 'use', 'label': 'research'},
    ]);
    expect(find.textContaining('Active session: research'), findsOneWidget);
    expect(find.text('Use'), findsOneWidget, reason: 'the other session now offers it');
  });

  testWidgets('a message left here is named as prepared, never as read', (tester) async {
    final posts = <Map<String, dynamic>>[];
    await pump(tester, posts);
    await tester.enterText(find.widgetWithText(TextField, 'Leave a message for this session'), 'Check the failing test.');
    await tester.tap(find.text('Leave it'));
    await tester.pumpAndSettle();
    expect(posts.single, {
      'path': '/api/deepseek',
      'action': 'send',
      'label': 'default',
      'text': 'Check the failing test.',
    });
    expect(find.textContaining('prepared'), findsWidgets);
    expect(find.textContaining('Check the failing test.'), findsOneWidget);
  });

  testWidgets('a new session needs a name before it is created', (tester) async {
    final posts = <Map<String, dynamic>>[];
    await pump(tester, posts);
    await tester.tap(find.text('New session'));
    await tester.pumpAndSettle();
    expect(posts, isEmpty, reason: 'an empty name is refused here, not at the route');
    expect(find.text('Name the session first.'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'New session name, for example research'), 'release');
    await tester.tap(find.text('New session'));
    await tester.pumpAndSettle();
    expect(posts.single['action'], 'new');
    expect(posts.single['label'], 'release');
  });

  testWidgets('a refused action is reported instead of looking like it worked', (tester) async {
    tester.view.physicalSize = const Size(1400, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DeepSeekPanel.calls(
            get: (path) async => view(),
            post: (path, data) async => throw Exception('400: Choose one of the DeepSeek sessions'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Use'));
    await tester.pumpAndSettle();
    expect(find.textContaining('That did not happen'), findsOneWidget);
    expect(find.textContaining('Choose one of the DeepSeek sessions'), findsOneWidget);
  });
}
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

/// Three coordinator views whose binding differs only in how the session was
/// created, so the Session info label has to tell them apart.
class SessionLabelGateway extends PreviewGateway {
  SessionLabelGateway() : super(fixture: 'activity', screen: 'activity');

  static int at(int minutes) {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day, 9, 41)
        .add(Duration(minutes: minutes))
        .millisecondsSinceEpoch;
  }

  List<Map<String, dynamic>> get bindings => [
    {
      'id': 'desktop',
      'name': 'Design',
      'alias': 'desktop',
      'provider': 'claude',
      'mode': 'desktop',
      'executionMode': 'desktop',
      'native_id': 'desktop-native-id',
      'cwd': '/sample/desktop',
    },
    {
      'id': 'cli',
      'name': 'Code',
      'alias': 'cli',
      'provider': 'codex',
      'mode': 'desktop',
      'executionMode': 'cli',
      'native_id': 'cli-native-id',
      'cwd': '/sample/cli',
    },
    {
      'id': 'unknown',
      'name': 'Legacy',
      'alias': 'unknown',
      'provider': 'claude',
      'mode': 'desktop',
      'native_id': 'unknown-native-id',
      'cwd': '/sample/unknown',
    },
  ];

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path.startsWith('/api/inbox-feed')) {
      final view = Uri.parse(path).queryParameters['view'] ?? 'all';
      final binding = bindings.where((b) => b['id'] == view).firstOrNull;
      return {
        'view': {
          'id': view,
          'kind': binding == null ? 'all' : 'coordinator',
          'name': binding == null ? 'One conversation' : '${binding['name']}',
          'provider': binding?['provider'],
          'count': 1,
          'firstAt': at(-5),
        },
        'views': [
          {
            'id': 'all',
            'kind': 'all',
            'name': 'One conversation',
            'count': 3,
            'latestAt': at(0),
            'preview': 'Ask Codex to fix the pricing table...',
          },
          for (final b in bindings)
            {
              'id': b['id'],
              'kind': 'coordinator',
              'name': b['name'],
              'provider': b['provider'],
              'detail': '${b['provider']} · ${b['executionMode'] ?? 'session'}',
              'count': 1,
              'latestAt': at(0),
              'preview': 'A request in this session',
            },
        ],
        'messages': [
          {
            'key': 'you:$view',
            'at': at(-5),
            'source': 'you',
            'kind': 'text',
            'channel': 'whatsapp',
            'text': 'Message for ${binding?['name'] ?? 'everyone'}.',
            'delivery': {'state': 'delivered', 'at': at(-4)},
          },
        ],
        'next': null,
        'stats': {'total': 3, 'firstAt': at(-5), 'lastAt': at(0), 'needsYou': 0},
      };
    }
    final data = await super.get(path);
    data['bindings'] = bindings;
    data['pendingJobs'] = [];
    data['jobs'] = [];
    data['approvals'] = [];
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
    tester.view.physicalSize = const Size(1280, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(FarFromDeskApp(gateway: SessionLabelGateway()));
    await tester.pumpAndSettle();

    Future<void> openInfo(String id) async {
      await tester.tap(find.byKey(ValueKey('inbox-view-$id')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('inbox-details')));
      await tester.pumpAndSettle();
    }

    Future<void> closeInfo() async {
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Done'),
        ),
      );
      await tester.pumpAndSettle();
    }

    Finder info(String text) => find.descendant(
      of: find.byType(AlertDialog),
      matching: find.text(text),
    );

    await openInfo('desktop');
    expect(info('Claude Desktop'), findsOneWidget);
    expect(info('/sample/desktop'), findsOneWidget);
    expect(info('desktop-native-id'), findsOneWidget);
    await closeInfo();

    await openInfo('cli');
    expect(info('Codex CLI'), findsOneWidget);
    expect(info('/sample/cli'), findsOneWidget);
    await closeInfo();

    await openInfo('unknown');
    expect(info('Claude session'), findsOneWidget);
    expect(info('Claude CLI'), findsNothing);
    expect(info('Claude Desktop'), findsNothing);
    await closeInfo();

    expect(tester.takeException(), isNull);
  });
}
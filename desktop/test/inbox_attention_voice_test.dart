import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

int feedAt(int minutes) {
  final now = DateTime.now();
  return DateTime(now.year, now.month, now.day, 9, 41)
      .add(Duration(minutes: minutes))
      .millisecondsSinceEpoch;
}

/// One attention entry as the feed serves it.
Map<String, dynamic> attentionCard(
  String key, {
  required String title,
  required String text,
  int minutes = 0,
  String? requestId,
  String? bindingId,
  String? destination,
  int? canReviewOrphan,
  String? status,
  bool? canClose,
  bool needsReview = true,
}) => {
  'key': key,
  'at': feedAt(minutes),
  'source': 'attention',
  'kind': 'attention',
  'kindLabel': title,
  'text': text,
  'needsReview': needsReview,
  // Null entries are simply absent fields as far as the pane is concerned.
  'requestId': requestId,
  'bindingId': bindingId,
  'destination': destination,
  'canReviewOrphan': canReviewOrphan,
  'status': status,
  'canClose': canClose,
};

/// Attention entries now arrive in the feed itself. This gateway serves them,
/// records every review, and keeps a status-level voice failure that must NOT
/// become a card: the feed is the only authority for what needs the owner.
class AttentionGateway extends PreviewGateway {
  AttentionGateway() : super(fixture: 'activity', screen: 'activity');
  List<Map<String, dynamic>> rows = [];
  final reviewPosts = <Map<String, dynamic>>[];
  final diagnosticCalls = <String>[];

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path.startsWith('/api/inbox-feed')) {
      final view = Uri.parse(path).queryParameters['view'] ?? 'all';
      final shown = view == 'attention' || view == 'all' ? rows : <Map<String, dynamic>>[];
      return {
        'view': {
          'id': view,
          'kind': view == 'attention' ? 'attention' : 'all',
          'name': view == 'attention' ? 'Needs you' : 'One conversation',
          'count': shown.length,
          'needsYou': rows.where((r) => r['needsReview'] == true).length,
          'firstAt': shown.isEmpty ? null : shown.first['at'],
        },
        'views': [
          {
            'id': 'all',
            'kind': 'all',
            'name': 'One conversation',
            'count': rows.length,
            'needsYou': rows.where((r) => r['needsReview'] == true).length,
            'latestAt': rows.isEmpty ? null : rows.last['at'],
            'preview': 'Ask Codex to fix the pricing table...',
          },
          {
            'id': 'attention',
            'kind': 'attention',
            'name': 'Needs you',
            'count': rows.length,
            'needsYou': rows.where((r) => r['needsReview'] == true).length,
            'latestAt': null,
            'preview': '',
          },
        ],
        'messages': shown,
        'next': null,
        'stats': {
          'total': rows.length,
          'firstAt': rows.isEmpty ? null : rows.first['at'],
          'lastAt': rows.isEmpty ? null : rows.last['at'],
          'needsYou': rows.where((r) => r['needsReview'] == true).length,
        },
      };
    }
    if (path.startsWith('/api/request-events')) {
      diagnosticCalls.add(path);
      return {
        'events': [
          {'event': 'PRIVATE OTHER DESTINATION'},
        ],
        'deliveries': <Map>[],
      };
    }
    final data = await super.get(path);
    data['pendingJobs'] = [];
    data['jobs'] = [];
    data['approvals'] = [];
    data['commandTurns'] = [];
    data['unlinkedUpdates'] = [];
    // An unresolved voice failure the old client would have turned into a row.
    data['voiceRequests'] = [
      {'id': 'wa:status-only', 'status': 'failed', 'created_at': feedAt(-30)},
    ];
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/voice-attention-review') {
      reviewPosts.add({'path': path, ...data});
      rows = rows
          .where(
            (r) =>
                r['requestId'] != data['audioId'] ||
                r['destination'] != data['destination'],
          )
          .toList();
      return {};
    }
    if (path == '/api/request-review') {
      reviewPosts.add({'path': path, ...data});
      rows = rows.where((r) => r['requestId'] != data['requestId']).toList();
      return {};
    }
    return super.post(path, data);
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
  void size(WidgetTester tester) {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    tester.view.physicalSize = const Size(1280, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  Future<void> openAttention(WidgetTester tester, AttentionGateway api) async {
    size(tester);
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('inbox-chip-attention')));
    await tester.pumpAndSettle();
  }

  Future<void> review(WidgetTester tester, Finder card) async {
    await tester.tap(
      find.descendant(of: card, matching: find.text('Mark reviewed')),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Mark reviewed'),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'Needs you shows the feed entries and reviews only the one that was asked',
    (tester) async {
      final api = AttentionGateway()
        ..rows = [
          attentionCard(
            'attention:voice:collision',
            title: 'Voice note failed',
            text: 'Correct voice error from chat B',
            minutes: 30,
            requestId: 'wa:collision',
            bindingId: 'unassigned-voice',
            destination: 'chat-b',
            canReviewOrphan: 1,
          ),
          attentionCard(
            'attention:voice:other',
            title: 'Voice note failed',
            text: 'Another failure',
            minutes: 20,
            requestId: 'wa:other',
            bindingId: 'unassigned-voice',
            destination: 'chat-c',
            canReviewOrphan: 1,
          ),
          attentionCard(
            'attention:request:tg:old',
            title: 'Needs review',
            text: 'Check the original session.',
            minutes: 10,
            requestId: 'tg:old',
            bindingId: 'sample-worker',
            status: 'uncertain',
            canClose: true,
          ),
        ];
      await openAttention(tester, api);
      final collision = find.byKey(
        const ValueKey('inbox-message-attention:voice:collision'),
      );
      expect(collision, findsOneWidget);
      expect(
        find.byKey(const ValueKey('inbox-message-attention:voice:other')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('inbox-message-attention:request:tg:old')),
        findsOneWidget,
      );
      // A status-level failure with no feed entry is not invented here.
      expect(find.textContaining('status-only'), findsNothing);
      expect(find.text('Correct voice error from chat B'), findsOneWidget);

      await review(tester, collision);
      expect(api.reviewPosts, [
        {
          'path': '/api/voice-attention-review',
          'audioId': 'wa:collision',
          'destination': 'chat-b',
          'confirmed': true,
        },
      ]);
      expect(collision, findsNothing);
      expect(
        find.byKey(const ValueKey('inbox-message-attention:voice:other')),
        findsOneWidget,
      );

      await review(
        tester,
        find.byKey(const ValueKey('inbox-message-attention:request:tg:old')),
      );
      expect(api.reviewPosts.last, {
        'path': '/api/request-review',
        'requestId': 'tg:old',
        'expectedStatus': 'uncertain',
        'confirmed': true,
      });
      expect(
        find.byKey(const ValueKey('inbox-message-attention:request:tg:old')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'An orphan voice review never opens another chat diagnostics',
    (tester) async {
      final api = AttentionGateway()
        ..rows = [
          attentionCard(
            'attention:voice:collision',
            title: 'Voice note failed',
            text: 'Correct voice error from chat B',
            requestId: 'wa:collision',
            bindingId: 'unassigned-voice',
            destination: 'chat-b',
            canReviewOrphan: 1,
          ),
        ];
      await openAttention(tester, api);
      final card = find.byKey(
        const ValueKey('inbox-message-attention:voice:collision'),
      );
      // The card carries the destination-checked error, and nothing offers to
      // read a request id that another chat may own.
      expect(find.text('Correct voice error from chat B'), findsOneWidget);
      expect(
        find.descendant(of: card, matching: find.text('Timing and delivery')),
        findsNothing,
      );
      await review(tester, card);
      expect(api.diagnosticCalls, isEmpty);
      expect(find.textContaining('PRIVATE OTHER DESTINATION'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('An entry with no identity renders without invented actions', (
    tester,
  ) async {
    final api = AttentionGateway()
      ..rows = [
        attentionCard(
          'attention:plain',
          title: 'Notice',
          text: 'Something happened.',
          needsReview: false,
        ),
      ];
    await openAttention(tester, api);
    final card = find.byKey(const ValueKey('inbox-message-attention:plain'));
    expect(card, findsOneWidget);
    expect(
      find.descendant(of: card, matching: find.text('Mark reviewed')),
      findsNothing,
    );
    expect(
      find.descendant(of: card, matching: find.text('Timing and delivery')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });
}
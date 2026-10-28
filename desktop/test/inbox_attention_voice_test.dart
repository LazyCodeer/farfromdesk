import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

class VoiceAttentionGateway extends PreviewGateway {
  VoiceAttentionGateway({required this.supportsAttention})
    : super(fixture: 'activity', screen: 'activity');
  final bool supportsAttention;
  List<Map> apiRows = [];
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path.startsWith('/api/inbox-thread?')) {
      if (path.contains('bindingId=')) {
        return {'messages': [], 'jobs': [], 'next': null};
      }
      return {'sessions': [], if (supportsAttention) 'attention': apiRows};
    }
    final data = await super.get(path);
    data['pendingJobs'] = [];
    data['jobs'] = [
      {
        'id': 'wa:reviewed',
        'binding_id': 'sample-worker',
        'status': 'reviewed',
        'created_at': 100,
        'preview': 'Reviewed voice',
      },
      {
        'id': 'wa:completed',
        'binding_id': 'sample-worker',
        'status': 'completed',
        'created_at': 200,
        'preview': 'Completed voice',
      },
    ];
    data['voiceRequests'] = [
      {'id': 'wa:reviewed', 'status': 'failed', 'created_at': 100},
      {'id': 'wa:completed', 'status': 'routing_blocked', 'created_at': 200},
      {'id': 'wa:active', 'status': 'failed', 'created_at': 300},
    ];
    data['commandTurns'] = [
      {
        'id': 'command-failed',
        'label': '/claude',
        'status': 'blocked',
        'summary': 'Not connected',
        'created_at': 400,
      },
    ];
    data['approvals'] = [];
    data['unlinkedUpdates'] = [];
    return data;
  }
}

class ReviewableVoiceGateway extends VoiceAttentionGateway {
  ReviewableVoiceGateway() : super(supportsAttention: true) {
    apiRows = [
      {
        'id': 'voice:wa:collision',
        'requestId': 'wa:collision',
        'bindingId': 'unassigned-voice',
        'destination': 'chat-b',
        'canReviewOrphan': 1,
        'title': 'Voice note failed',
        'text': 'Open the recorded timing and cause.',
        'at': 300,
      },
      {
        'id': 'voice:wa:other',
        'requestId': 'wa:other',
        'bindingId': 'unassigned-voice',
        'destination': 'chat-c',
        'canReviewOrphan': 1,
        'title': 'Voice note failed',
        'text': 'Another failure',
        'at': 200,
      },
    ];
  }
  final diagnosticCalls = <String>[];
  final reviewCalls = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path.startsWith('/api/request-events')) {
      diagnosticCalls.add(path);
      return {
        'events': [
          {'event': 'UNRELATED SECRET REQUEST'},
        ],
        'deliveries': [],
      };
    }
    if (path.startsWith('/api/inbox-thread?')) {
      if (path.contains('bindingId=')) {
        return {
          'messages': [
            {
              'key': '0:voice:wa:collision',
              'requestId': 'wa:collision',
              'kind': 'voice-failed',
              'text': 'Correct voice error from chat B',
              'at': 300,
              'destination': 'chat-b',
              'voice': 1,
            },
          ],
          'jobs': [],
          'next': null,
        };
      }
      return {
        'sessions': [
          {
            'id': 'unassigned-voice',
            'name': 'Unassigned voice notes',
            'latestAt': 300,
            'preview': 'Voice note not routed',
            'needsReview': apiRows.length,
            'waiting': 0,
            'answered': 0,
            'closed': 0,
          },
        ],
        'attention': apiRows,
      };
    }
    final data = await super.get(path);
    (data['jobs'] as List).add({
      'id': 'wa:collision',
      'binding_id': 'sample-worker',
      'status': 'completed',
      'destination': 'chat-a',
      'created_at': 300,
      'preview': 'UNRELATED SECRET REQUEST',
    });
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/voice-attention-review') {
      reviewCalls.add(Map.of(data));
      apiRows = apiRows
          .where(
            (row) =>
                row['requestId'] != data['audioId'] ||
                row['destination'] != data['destination'],
          )
          .toList();
      return {'ok': true};
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
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets('Attention shows only authoritative unresolved voice failures', (
    tester,
  ) async {
    size(tester);
    final api = VoiceAttentionGateway(supportsAttention: true);
    api.apiRows = [
      {
        'id': 'voice:wa:active',
        'requestId': 'wa:active',
        'bindingId': 'unassigned-voice',
        'title': 'Voice note failed',
        'text': 'Unresolved',
        'at': 300,
      },
      {
        'id': 'delivery:1',
        'requestId': 'wa:active',
        'bindingId': 'sample-worker',
        'title': 'Reply delivery needs attention',
        'text': 'Delivery failed',
        'at': 500,
      },
    ];
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('inbox-tab-Attention')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('inbox-attention-voice:wa:reviewed')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('inbox-attention-voice:wa:completed')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('inbox-attention-voice:wa:active')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('inbox-attention-delivery:1')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('inbox-attention-command:command-failed')),
      findsOneWidget,
    );
    api.apiRows = [];
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('inbox-attention-voice:wa:active')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('inbox-attention-command:command-failed')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'Orphan review clears only its exact row and never fetches colliding request details',
    (tester) async {
      size(tester);
      final api = ReviewableVoiceGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('inbox-tab-Attention')));
      await tester.pumpAndSettle();
      final row = find.byKey(
        const ValueKey('inbox-attention-voice:wa:collision'),
      );
      await tester.tap(
        find.descendant(of: row, matching: find.text('Voice note failed')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Correct voice error from chat B'), findsOneWidget);
      expect(find.text('UNRELATED SECRET REQUEST'), findsNothing);
      expect(api.diagnosticCalls, isEmpty);
      final bubble = find.byKey(
        const ValueKey('inbox-message-0:voice:wa:collision'),
      );
      expect(
        find.descendant(of: bubble, matching: find.text('Details')),
        findsNothing,
      );
      final review = find.descendant(
        of: row,
        matching: find.text('Mark reviewed'),
      );
      await tester.tap(review);
      await tester.pumpAndSettle();
      expect(find.text('Mark this voice note reviewed?'), findsOneWidget);
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Mark reviewed'),
        ),
      );
      await tester.pumpAndSettle();
      expect(api.reviewCalls, [
        {'audioId': 'wa:collision', 'destination': 'chat-b', 'confirmed': true},
      ]);
      expect(
        find.byKey(const ValueKey('inbox-attention-voice:wa:collision')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('inbox-attention-voice:wa:other')),
        findsOneWidget,
      );
      expect(api.diagnosticCalls, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('Older backends still surface status voice failures', (
    tester,
  ) async {
    size(tester);
    await tester.pumpWidget(
      FarFromDeskApp(gateway: VoiceAttentionGateway(supportsAttention: false)),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('inbox-tab-Attention')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('inbox-attention-voice:wa:reviewed')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('inbox-attention-voice:wa:completed')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('inbox-attention-voice:wa:active')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}

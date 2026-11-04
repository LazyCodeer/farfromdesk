import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/chat_message_text.dart';
import 'package:farfromdesk/preview.dart';

/// A fake /api/inbox-feed. Every request is recorded, so a view switch, a
/// search and a page can all be proven from what the pane asked for.
class FeedGateway extends PreviewGateway {
  FeedGateway() : super(fixture: 'activity', screen: 'activity');
  final feedRequests = <String>[];
  final sendPosts = <Map<String, dynamic>>[];
  final reviewPosts = <Map<String, dynamic>>[];
  /// When set, the payload reports these chip counts instead of the default.
  List<Map<String, dynamic>>? filterOverride;
  int olderCalls = 0;
  String? feedError;
  String? sendError;
  Map<String, dynamic>? sendResult;
  Completer<void>? sendGate;

  static int at(int minutes) {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day, 9, 41)
        .add(Duration(minutes: minutes))
        .millisecondsSinceEpoch;
  }

  Map<String, dynamic> delivery(String state, [int? minutes]) => {
    'state': state,
    if (minutes != null) 'at': at(minutes),
  };

  List<Map<String, dynamic>> get all => [
    {
      'key': 'you:voice:test',
      'at': at(0),
      'source': 'you',
      'kind': 'voice',
      'channel': 'whatsapp',
      'origin': 'app',
      'text': 'Ask Codex to fix the pricing table.',
      'voice': {'durationMs': 14000},
      'delivery': delivery('delivered', 4),
      'requestId': 'wa:test',
    },
    {
      'key': 'you:voice:none',
      'at': at(1),
      'source': 'you',
      'kind': 'voice',
      'channel': 'whatsapp',
      'text': 'Second voice note with no reported duration.',
      'delivery': delivery('sent', 2),
    },
    {
      'key': 'brain:routing:test',
      'at': at(6),
      'source': 'brain',
      'kind': 'routing',
      'text': 'Routed to Website redesign (Codex). No other session matched.',
    },
    {
      'key': 'work:test',
      'at': at(9),
      'source': 'coordinator',
      'provider': 'codex',
      'bindingId': 'alpha',
      'sessionName': 'Website redesign',
      'kind': 'working',
      'kindLabel': 'Working',
      'text': 'Confirming the fix before I call it done.',
      'delivery': delivery('sent'),
      'requestId': 'wa:test',
    },
    {
      'key': 'update:test',
      'at': at(17),
      'source': 'coordinator',
      'provider': 'claude',
      'bindingId': 'beta',
      'sessionName': 'Docs pass',
      'kind': 'update',
      'kindLabel': 'Update',
      'text': 'Pagination reference updated.',
      'delivery': delivery('queued'),
    },
    {
      'key': 'final:test',
      'at': at(20),
      'source': 'coordinator',
      'provider': 'codex',
      'bindingId': 'alpha',
      'sessionName': 'Website redesign',
      'itemRef': 3,
      'kind': 'final',
      'kindLabel': 'Final',
      'text': 'No overflow at 375 px or 320 px.',
      'delivery': delivery('delivered', 32),
    },
    // The shapes Sagar's real database sends: the attribution rides in the
    // reply body, and the provider/session are not separate fields at all.
    {
      'key': 'meta:full',
      'at': at(30),
      'source': 'coordinator',
      'kind': 'final',
      'kindLabel': 'Final',
      'text':
          '👋 *Hi!*\nYou: What would you like to work on?\n\n🤖 Provider: Codex Desktop\n💬 Session Name: FarFromDesk coordinator setup\n🎨 Mode: Social · Images: Local SVG',
      'delivery': delivery('delivered', 40),
    },
    {
      'key': 'meta:short',
      'at': at(31),
      'source': 'coordinator',
      'kind': 'final',
      'kindLabel': 'Final',
      'text':
          '👋 *Hi!*\nYou: What would you like to work on?\n\n🤖 Codex Desktop',
      'delivery': delivery('uncertain'),
    },
    // The shape 18 of the 19 real rows use: the metadata words carry no emoji.
    {
      'key': 'meta:none',
      'at': at(32),
      'source': 'coordinator',
      'provider': 'codex',
      'bindingId': 'alpha',
      'sessionName': 'Website redesign',
      'kind': 'update',
      'kindLabel': 'Update',
      'text':
          '*Session: Codex Desktop · FarFromDesk coordinator setup*\n\n💬 *Message received*\nGot your message. I’ll coordinate this and keep you updated.\n\nMode: Social · Images: Local SVG\n\n— FarFromDesk',
      'delivery': delivery('delivered', 33),
    },
    {
      'key': 'long:left',
      'at': at(37),
      'source': 'coordinator',
      'provider': 'codex',
      'bindingId': 'alpha',
      'sessionName': 'Website redesign',
      'kind': 'update',
      'kindLabel': 'Update',
      'text':
          'A long left reply that has to wrap across several lines so the width cap is what limits the bubble rather than the length of the words in it, which is the point of measuring the thread content box instead of trusting a constant.',
      'delivery': delivery('delivered', 38),
    },
    {
      'key': 'long:right',
      'at': at(38),
      'source': 'you',
      'kind': 'text',
      'channel': 'telegram',
      'text':
          'A long message of my own that also has to wrap across several lines so the same cap can be measured on the right hand side of the thread without the content deciding the width for us.',
      'delivery': delivery('delivered', 39),
    },
    {
      'key': 'attention:test',
      'at': at(24),
      'source': 'attention',
      'kind': 'attention',
      'kindLabel': 'Voice note · routing blocked',
      'text': 'Transcript saved, but the original chat could not be routed.',
      'requestId': 'wa:voice',
      'bindingId': 'unassigned-voice',
      'destination': 'original-owner',
      'canReviewOrphan': 1,
      'needsReview': true,
    },
    {
      'key': 'command:test',
      'at': at(28),
      'source': 'command',
      'kind': 'command',
      'kindLabel': 'Command',
      'text': '2 requests open. Nothing is waiting on you.',
    },
  ];

  List<Map<String, dynamic>> page(String view) => switch (view) {
    'you' => all.where((m) => m['source'] == 'you').toList(),
    'coordinators' => all.where((m) => m['source'] == 'coordinator').toList(),
    'alpha' || 'beta' => all.where((m) => m['bindingId'] == view).toList(),
    'brain' => all.where((m) => m['source'] == 'brain').toList(),
    'commands' => all.where((m) => m['source'] == 'command').toList(),
    'attention' => all.where((m) => m['source'] == 'attention').toList(),
    _ => all,
  };

  List<Map<String, dynamic>> get views => [
    {
      'id': 'all',
      'kind': 'all',
      'name': 'One conversation',
      'count': 34,
      'needsYou': 2,
      'latestAt': at(28),
      'preview': 'Ask Codex to fix the pricing table...',
    },
    {
      'id': 'you',
      'kind': 'you',
      'name': 'You',
      'count': 12,
      'latestAt': at(1),
      'preview': 'Ask Codex to fix the pricing table...',
    },
    {
      'id': 'alpha',
      'kind': 'coordinator',
      'name': 'Website redesign',
      'provider': 'codex',
      'detail': 'Codex · Terminal',
      'count': 8,
      'latestAt': at(20),
      'preview': 'Update layout and fix mobile overflow',
    },
    {
      'id': 'beta',
      'kind': 'coordinator',
      'name': 'Docs pass',
      'provider': 'claude',
      'detail': 'Claude · Desktop',
      'count': 5,
      'latestAt': at(17),
      'preview': 'Pagination reference updated...',
    },
    {
      'id': 'brain',
      'kind': 'brain',
      'name': 'Brain',
      'count': 4,
      'latestAt': null,
      'preview': '',
    },
    {
      'id': 'commands',
      'kind': 'command',
      'name': 'Status',
      'count': 3,
      'latestAt': at(28),
      'preview': '2 requests open. Nothing is waiting...',
    },
    {
      'id': 'attention',
      'kind': 'attention',
      'name': 'Needs you',
      'count': 2,
      'needsYou': 2,
      'latestAt': at(24),
      'preview': '',
    },
  ];

  /// What the bridge reports for the chip row: every group, counted globally.
  List<Map<String, dynamic>> get filters =>
      filterOverride ??
      const [
        {'id': 'all', 'label': 'All', 'count': 34},
        {'id': 'you', 'label': 'You', 'count': 12},
        {'id': 'coordinators', 'label': 'Coordinators', 'count': 13},
        {'id': 'brain', 'label': 'Brain', 'count': 4},
        {'id': 'commands', 'label': 'Commands', 'count': 3},
        {'id': 'attention', 'label': 'Needs you', 'count': 2},
      ];

  static const filterNames = {
    'you': 'You',
    'coordinators': 'Coordinators',
    'brain': 'Brain',
    'commands': 'Status',
    'attention': 'Needs you',
  };

  Map<String, dynamic> feed(String path) {
    final uri = Uri.parse(path);
    final view = uri.queryParameters['view'] ?? 'all';
    final older = uri.queryParameters['beforeAt'] != null;
    if (older) olderCalls++;
    final rows = older
        ? [
            {
              'key': 'old:one',
              'at': at(-700),
              'source': 'you',
              'kind': 'text',
              'channel': 'whatsapp',
              'text': 'Earlier owner request',
              'delivery': delivery('delivered', -699),
            },
            {
              'key': 'old:two',
              'at': at(-690),
              'source': 'coordinator',
              'provider': 'codex',
              'bindingId': 'alpha',
              'sessionName': 'Website redesign',
              'kind': 'update',
              'kindLabel': 'Update',
              'text': 'Earlier reply from the session.',
              'delivery': delivery('delivered', -689),
            },
          ]
        : page(view);
    // A filter-only group has no row in `views`, but the feed still answers
    // with a view for it, exactly as the bridge does.
    final current =
        views.where((v) => v['id'] == view).firstOrNull ??
        <String, dynamic>{
          'id': view,
          'kind': view == 'coordinators' ? 'coordinator' : view,
          'name': filterNames[view] ?? 'One conversation',
        };
    return {
      'view': {
        ...current,
        'firstAt': rows.isEmpty ? null : rows.first['at'],
      },
      'views': views,
      'filters': filters,
      'messages': rows,
      'next': older || rows.isEmpty
          ? null
          : {'at': rows.first['at'], 'key': '${rows.first['key']}'},
      'stats': {'total': 34, 'firstAt': at(0), 'lastAt': at(28), 'needsYou': 2},
    };
  }

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path.startsWith('/api/inbox-feed')) {
      feedRequests.add(path);
      if (feedError != null) throw StateError(feedError!);
      return feed(path);
    }
    if (path.startsWith('/api/request-events')) {
      return {'events': <Map>[], 'deliveries': <Map>[]};
    }
    final data = await super.get(path);
    data['bindings'] = [
      {
        'id': 'alpha',
        'alias': 'alpha',
        'name': 'Website redesign',
        'provider': 'codex',
        'executionMode': 'cli',
        'native_id': 'alpha-native-id',
        'cwd': '/sample/alpha',
      },
    ];
    data['pendingJobs'] = [];
    data['jobs'] = [];
    data['approvals'] = [];
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/inbox-send') {
      sendPosts.add(Map.of(data));
      if (sendGate != null) await sendGate!.future;
      if (sendError != null) throw StateError(sendError!);
      return sendResult ?? {'requestId': 'app:1', 'status': 'queued'};
    }
    if (path == '/api/voice-attention-review' || path == '/api/request-review') {
      reviewPosts.add({'path': path, ...data});
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
    // Tall enough that the whole canned conversation is laid out, so an
    // assertion about the first message is not really an assertion about scroll.
    tester.view.physicalSize = const Size(1280, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  Future<void> open(WidgetTester tester, FeedGateway api) async {
    size(tester);
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
  }

  Finder countIn(String chip, String count) => find.descendant(
    of: find.byKey(ValueKey('inbox-chip-$chip')),
    matching: find.text(count),
  );

  testWidgets('the six view chips render the counts the feed reported', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    expect(api.feedRequests.single, contains('view=all'));
    for (final (chip, count) in [
      ('all', '34'),
      ('you', '12'),
      ('coordinators', '13'),
      ('brain', '4'),
      ('commands', '3'),
      ('attention', '2'),
    ]) {
      expect(find.byKey(ValueKey('inbox-chip-$chip')), findsOneWidget);
      expect(countIn(chip, count), findsOneWidget, reason: chip);
    }
    // The unified view is the one selected first.
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('inbox-header')),
        matching: find.text('One conversation'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('chip counts come from filters, including a group with none', (
    tester,
  ) async {
    final api = FeedGateway()
      ..filterOverride = const [
        {'id': 'all', 'label': 'All', 'count': 145},
        {'id': 'you', 'label': 'You', 'count': 26},
        {'id': 'coordinators', 'label': 'Coordinators', 'count': 101},
        {'id': 'brain', 'label': 'Brain', 'count': 0},
        {'id': 'commands', 'label': 'Commands', 'count': 13},
        {'id': 'attention', 'label': 'Needs you', 'count': 3},
      ];
    await open(tester, api);
    // The numbers differ from anything `views` could be summed to, so the chips
    // are proven to read the feed's own filters.
    for (final (chip, count) in [
      ('all', '145'),
      ('you', '26'),
      ('coordinators', '101'),
      ('brain', '0'),
      ('commands', '13'),
      ('attention', '3'),
    ]) {
      expect(find.byKey(ValueKey('inbox-chip-$chip')), findsOneWidget);
      expect(countIn(chip, count), findsOneWidget, reason: chip);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('the You and Coordinators chips filter the feed by view id', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    Finder header(String text) => find.descendant(
      of: find.byKey(const ValueKey('inbox-header')),
      matching: find.text(text),
    );
    await tester.tap(find.byKey(const ValueKey('inbox-chip-you')));
    await tester.pumpAndSettle();
    expect(api.feedRequests.last, contains('view=you'));
    expect(find.byKey(const ValueKey('inbox-error')), findsNothing);
    expect(header('You'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('inbox-message-you:voice:test')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('inbox-message-work:test')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('inbox-chip-coordinators')));
    await tester.pumpAndSettle();
    expect(api.feedRequests.last, contains('view=coordinators'));
    expect(find.byKey(const ValueKey('inbox-error')), findsNothing);
    expect(header('Coordinators'), findsOneWidget);
    expect(find.byKey(const ValueKey('inbox-message-work:test')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('inbox-message-you:voice:test')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a voice note shows its duration only when one is reported', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    expect(find.text('Voice note · 0:14'), findsOneWidget);
    // The second voice note reports no duration, so the line stands alone.
    expect(find.text('Voice note'), findsOneWidget);
    expect(find.textContaining('null'), findsNothing);
    expect(find.textContaining('Voice note · null'), findsNothing);
    expect(tester.takeException(), isNull);
  });  testWidgets('a left message keeps nothing under its bubble', (tester) async {
    final api = FeedGateway();
    await open(tester, api);
    final message = find.byKey(const ValueKey('inbox-message-work:test'));
    final bubble = find.byKey(const ValueKey('inbox-bubble-work:test'));
    expect(bubble, findsOneWidget);
    // No meta row under a left bubble at all.
    expect(
      find.byKey(const ValueKey('inbox-attribution-work:test')),
      findsNothing,
    );
    // The time is the last thing inside the bubble, at its own edge.
    final bubbleRect = tester.getRect(bubble);
    final time = find.descendant(of: bubble, matching: find.text('09:50'));
    expect(time, findsOneWidget);
    expect(bubbleRect.contains(tester.getRect(time).center), isTrue);
    // Nothing below the bubble inside the message.
    final below = find
        .descendant(of: message, matching: find.byType(Text))
        .evaluate()
        .where(
          (e) =>
              tester.getRect(find.byWidget(e.widget)).top >=
              bubbleRect.bottom - 0.5,
        )
        .length;
    expect(below, 0);
    expect(tester.takeException(), isNull);
  });  testWidgets('there are exactly two bubble surfaces, one per side', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    BoxDecoration paint(String key) =>
        tester.widget<Container>(
          find.byKey(ValueKey('inbox-bubble-$key')),
        ).decoration!
            as BoxDecoration;
    Color fill(String key) => paint(key).color!;
    Color edge(String key) => (paint(key).border! as Border).top.color;

    // A final is the same surface as any other reply on its side.
    expect(fill('final:test'), fill('work:test'));
    expect(fill('final:test'), fill('update:test'));
    expect(fill('final:test'), fill('brain:routing:test'));
    expect(edge('final:test'), edge('work:test'));

    // A right bubble is the other surface, and nothing else is.
    expect(fill('you:voice:test'), isNot(fill('final:test')));
    expect(fill('you:voice:none'), fill('you:voice:test'));
    expect(edge('you:voice:test'), isNot(edge('final:test')));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a reply body never shows the bridge attribution block', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    const body = '👋 *Hi!*\nYou: What would you like to work on?';
    final full = find.byKey(const ValueKey('inbox-message-meta:full'));
    final attribution = find.byKey(
      const ValueKey('inbox-attribution-meta:full'),
    );
    expect(full, findsOneWidget);
    // The renderer receives exactly the body: the attribution block is gone
    // from the text that reaches the bubble.
    expect(
      tester
          .widget<ChatMessageText>(
            find.descendant(of: full, matching: find.byType(ChatMessageText)),
          )
          .text,
      body,
    );
    expect(
      find.descendant(of: full, matching: find.textContaining('Provider:')),
      findsNothing,
    );
    expect(
      find.descendant(of: full, matching: find.textContaining('Session Name:')),
      findsNothing,
    );
    // The block is not lost: it is in the details panel, never in the body.
    expect(attribution, findsNothing);
    await tester.tap(find.byKey(const ValueKey('inbox-details-meta:full')));
    await tester.pumpAndSettle();
    final panel = find.byKey(
      const ValueKey('inbox-details-panel-meta:full'),
    );
    expect(panel, findsOneWidget);
    expect(
      find.descendant(
        of: panel,
        matching: find.text('FarFromDesk coordinator setup'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: panel, matching: find.text('Codex Desktop')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: panel,
        matching: find.text('Social · Images: Local SVG'),
      ),
      findsOneWidget,
    );
    // The short form carries the provider and nothing else.
    final short = find.byKey(const ValueKey('inbox-message-meta:short'));
    expect(
      tester
          .widget<ChatMessageText>(
            find.descendant(of: short, matching: find.byType(ChatMessageText)),
          )
          .text,
      body,
    );
    // The short form names the provider only, so its panel has no session.
    expect(
      find.descendant(of: short, matching: find.textContaining('Mode:')),
      findsNothing,
    );
    await tester.tap(find.byKey(const ValueKey('inbox-details-meta:short')));
    await tester.pumpAndSettle();
    final shortPanel = find.byKey(
      const ValueKey('inbox-details-panel-meta:short'),
    );
    expect(shortPanel, findsOneWidget);
    expect(
      find.descendant(of: shortPanel, matching: find.text('Codex Desktop')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: shortPanel, matching: find.text('Session')),
      findsNothing,
    );

    // The emoji-less shape is the common one and it is stripped the same way.
    const plain = '💬 *Message received*\nGot your message. I’ll coordinate this and keep you updated.';
    final none = find.byKey(const ValueKey('inbox-message-meta:none'));
    expect(
      tester
          .widget<ChatMessageText>(
            find.descendant(of: none, matching: find.byType(ChatMessageText)),
          )
          .text,
      plain,
    );
    expect(
      find.descendant(of: none, matching: find.textContaining('Mode:')),
      findsNothing,
    );
    expect(
      find.descendant(of: none, matching: find.textContaining('— FarFromDesk')),
      findsNothing,
    );
    await tester.tap(find.byKey(const ValueKey('inbox-details-meta:none')));
    await tester.pumpAndSettle();
    final nonePanel = find.byKey(
      const ValueKey('inbox-details-panel-meta:none'),
    );
    expect(
      find.descendant(
        of: nonePanel,
        matching: find.text('Social · Images: Local SVG'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });  testWidgets('a brain entry is an ordinary left message with its own mark', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    final narration = find.byKey(
      const ValueKey('inbox-narration-brain:routing:test'),
    );
    final bubble = find.byKey(
      const ValueKey('inbox-bubble-brain:routing:test'),
    );
    expect(narration, findsOneWidget);
    expect(bubble, findsOneWidget);
    expect(
      find.descendant(
        of: bubble,
        matching: find.textContaining('Routed to Website redesign (Codex).'),
      ),
      findsOneWidget,
    );
    // Same shape as every other left message: mark beside it, nothing under it.
    expect(
      find.byKey(const ValueKey('inbox-narration-brain:routing:test')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('inbox-attribution-brain:routing:test')),
      findsNothing,
    );
    expect(
      find.descendant(of: bubble, matching: find.text('09:47')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
  testWidgets('every message is one row: the mark sits beside the bubble', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    Rect box(String key) => tester.getRect(find.byKey(ValueKey(key)));
    bool spans(Rect a, Rect b) => a.top < b.bottom && b.top < a.bottom;

    // Incoming: the mark is left of the bubble, in the same row.
    final inMark = box('inbox-mark-work:test');
    final inBubble = box('inbox-bubble-work:test');
    expect(inMark.right, lessThanOrEqualTo(inBubble.left));
    expect(spans(inMark, inBubble), isTrue);

    // Outgoing mirrors it: the channel mark sits right of the bubble, same row, so the two
    // sides read as the same pattern. This is the shape the owner asked for explicitly.
    final outMark = box('inbox-mark-you:voice:test');
    final outBubble = box('inbox-bubble-you:voice:test');
    expect(outMark.left, greaterThanOrEqualTo(outBubble.right));
    expect(spans(outMark, outBubble), isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a bubble takes at most 70% of the thread content box', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    final thread = tester.getRect(
      find.byKey(const PageStorageKey('inbox-timeline')),
    );
    // The thread content box: the timeline's own horizontal padding removed.
    final content = thread.width - 40;
    Rect bubble(String key) => tester.getRect(
      find.byKey(ValueKey('inbox-bubble-$key')),
    );
    // A long message is limited by the cap, on both sides.
    expect(bubble('long:left').width, closeTo(content * .7, 1));
    expect(bubble('long:right').width, closeTo(content * .7, 1));
    // A short one stays narrower, and still inside the cap.
    for (final key in ['work:test', 'final:test', 'you:voice:test']) {
      expect(
        bubble(key).width,
        lessThanOrEqualTo(content * .7 + 0.5),
        reason: key,
      );
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('a right message keeps its channel mark and prints no channel word', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    final message = find.byKey(const ValueKey('inbox-message-you:voice:test'));
    // The mark stays: it is how you tell WhatsApp from Telegram at a glance.
    expect(
      find.byKey(const ValueKey('inbox-mark-you:voice:test')),
      findsOneWidget,
    );
    bool hasAsset(Finder scope, String needle) => find
        .descendant(
          of: scope,
          matching: find.byWidgetPredicate(
            (w) =>
                w is Image &&
                w.image is AssetImage &&
                (w.image as AssetImage).assetName.contains(needle),
          ),
        )
        .evaluate()
        .isNotEmpty;
    expect(
      hasAsset(message, 'logo-whatsapp'),
      isTrue,
      reason: 'the fixture message arrived on WhatsApp',
    );
    // The word does not: the mark already said it.
    for (final word in ['WhatsApp', 'Telegram']) {
      expect(
        find.descendant(of: message, matching: find.textContaining(word)),
        findsNothing,
        reason: word,
      );
    }
    // Just the time and the ticks, with App because it was typed here.
    expect(
      find.descendant(of: message, matching: find.text('App · 09:41 ✓✓')),
      findsOneWidget,
    );
    // A reply that went through a chat prints neither word either.
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('inbox-message-you:voice:none')),
        matching: find.text('09:42 ✓'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('the details panel opens and closes from the bubble', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    final toggle = find.byKey(const ValueKey('inbox-details-work:test'));
    expect(toggle, findsOneWidget);
    expect(
      find.byKey(const ValueKey('inbox-details-panel-work:test')),
      findsNothing,
    );
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    final panel = find.byKey(
      const ValueKey('inbox-details-panel-work:test'),
    );
    expect(panel, findsOneWidget);
    // The provider in words, the session, the kind and the delivery state.
    expect(
      find.descendant(of: panel, matching: find.text('Codex')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: panel, matching: find.text('Website redesign')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: panel, matching: find.text('Working')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: panel, matching: find.text('Sent to session')),
      findsOneWidget,
    );
    // None of it is printed inside the bubble.
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('inbox-bubble-work:test')),
        matching: find.text('Codex'),
      ),
      findsNothing,
    );
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('inbox-details-panel-work:test')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('no message has a label row above its bubble', (tester) async {
    final api = FeedGateway();
    await open(tester, api);
    // The provider label and the kind pill the old header row carried are gone
    // from the message area entirely.
    for (final gone in [
      'Codex session',
      'Claude session',
      'Working',
      'Update',
    ]) {
      expect(find.text(gone), findsNothing, reason: gone);
    }
    for (final key in [
      'work:test',
      'update:test',
      'final:test',
      'brain:routing:test',
      'you:voice:test',
      'meta:full',
    ]) {
      final message = find.byKey(ValueKey('inbox-message-$key'));
      final bubble = find.byKey(ValueKey('inbox-bubble-$key'));
      expect(bubble, findsOneWidget, reason: key);
      final bubbleTop = tester.getTopLeft(bubble).dy;
      final above = find
          .descendant(of: message, matching: find.byType(Text))
          .evaluate()
          .where(
            (e) =>
                tester.getRect(find.byWidget(e.widget)).bottom <=
                bubbleTop + 0.5,
          )
          .length;
      expect(above, 0, reason: 'text above the bubble in $key');
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('choosing a coordinator view re-queries the feed by view id', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    await tester.tap(find.byKey(const ValueKey('inbox-view-alpha')));
    await tester.pumpAndSettle();
    expect(api.feedRequests.last, contains('view=alpha'));
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('inbox-header')),
        matching: find.text('Website redesign'),
      ),
      findsOneWidget,
    );
    // Only that session's messages are shown.
    expect(find.byKey(const ValueKey('inbox-message-final:test')), findsOneWidget);
    expect(find.byKey(const ValueKey('inbox-message-update:test')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an attention entry renders a card with a working review', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    await tester.tap(find.byKey(const ValueKey('inbox-chip-attention')));
    await tester.pumpAndSettle();
    expect(api.feedRequests.last, contains('view=attention'));
    final card = find.byKey(const ValueKey('inbox-message-attention:test'));
    expect(card, findsOneWidget);
    expect(
      find.descendant(
        of: card,
        matching: find.text('Voice note · routing blocked'),
      ),
      findsOneWidget,
    );
    await tester.tap(
      find.descendant(of: card, matching: find.text('Mark reviewed')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Mark this voice note reviewed?'), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Mark reviewed'),
      ),
    );
    await tester.pumpAndSettle();
    expect(api.reviewPosts, [
      {
        'path': '/api/voice-attention-review',
        'audioId': 'wa:voice',
        'destination': 'original-owner',
        'confirmed': true,
      },
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the composer sends the trimmed text exactly once and clears', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    final field = find.byKey(const ValueKey('inbox-composer-field'));
    final send = find.byKey(const ValueKey('inbox-composer-send'));
    expect(field, findsOneWidget);
    expect(send, findsOneWidget);
    final before = api.feedRequests.length;
    api.sendGate = Completer<void>();
    await tester.enterText(field, '  fix the pricing table  ');
    await tester.pump();
    await tester.tap(send);
    await tester.pump();
    // In flight: the field and the button are both out of action.
    expect(tester.widget<TextField>(field).enabled, isFalse);
    expect(tester.widget<IconButton>(send).onPressed, isNull);
    api.sendGate!.complete();
    await tester.pumpAndSettle();
    expect(api.sendPosts, [
      {'text': 'fix the pricing table'},
    ]);
    expect(tester.widget<TextField>(field).controller!.text, '');
    // The feed reloads so the sent message appears.
    expect(api.feedRequests.length, greaterThan(before));
    expect(tester.takeException(), isNull);
  });

  testWidgets('Enter sends the reply as well', (tester) async {
    final api = FeedGateway();
    await open(tester, api);
    await tester.enterText(
      find.byKey(const ValueKey('inbox-composer-field')),
      'one more fix',
    );
    await tester.pump();
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(api.sendPosts, [
      {'text': 'one more fix'},
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an empty or whitespace field never posts', (tester) async {
    final api = FeedGateway();
    await open(tester, api);
    final field = find.byKey(const ValueKey('inbox-composer-field'));
    final send = find.byKey(const ValueKey('inbox-composer-send'));
    expect(tester.widget<IconButton>(send).onPressed, isNull);
    await tester.tap(send);
    await tester.pumpAndSettle();
    await tester.enterText(field, '   ');
    await tester.pump();
    expect(tester.widget<IconButton>(send).onPressed, isNull);
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(api.sendPosts, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed send keeps the typed text and shows the error', (
    tester,
  ) async {
    final api = FeedGateway()..sendError = 'The bridge is stopped.';
    await open(tester, api);
    final field = find.byKey(const ValueKey('inbox-composer-field'));
    await tester.enterText(field, 'please fix the table');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('inbox-composer-send')));
    await tester.pumpAndSettle();
    expect(api.sendPosts, [
      {'text': 'please fix the table'},
    ]);
    expect(
      tester.widget<TextField>(field).controller!.text,
      'please fix the table',
    );
    expect(find.byKey(const ValueKey('inbox-error')), findsOneWidget);
    expect(find.text('The bridge is stopped.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('only text is offered: the add and mic controls stay disabled', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    for (final key in ['inbox-composer-new', 'inbox-composer-mic']) {
      final control = find.byKey(ValueKey(key));
      expect(control, findsOneWidget);
      expect(tester.widget<IconButton>(control).onPressed, isNull, reason: key);
      expect(
        find.byTooltip(
          'Only text replies are supported here. Send photos or voice from WhatsApp or Telegram.',
        ),
        findsWidgets,
        reason: key,
      );
    }
    expect(
      find.byTooltip(
        'Send as yourself. The brain routes it, or your coordinator answers.',
      ),
      findsWidgets,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('earlier pages append above the current messages', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    expect(find.byKey(const ValueKey('inbox-message-old:one')), findsNothing);
    // The timeline opens anchored at the newest message, so the earlier-page
    // control is found by scrolling back up, exactly as the owner would.
    await tester.drag(
      find.byKey(const PageStorageKey('inbox-timeline')),
      const Offset(0, 2000),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('inbox-earlier')));
    await tester.pumpAndSettle();
    expect(api.olderCalls, 1);
    expect(api.feedRequests.last, contains('beforeAt='));
    expect(api.feedRequests.last, contains('beforeKey='));
    // The reading position is preserved, so the earlier page is found by
    // scrolling up again rather than by being jumped to.
    await tester.drag(
      find.byKey(const PageStorageKey('inbox-timeline')),
      const Offset(0, 2000),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('inbox-message-old:one')), findsOneWidget);
    // The page that was already loaded is still there, ordered oldest first.
    expect(
      find.byKey(const ValueKey('inbox-message-you:voice:test')),
      findsOneWidget,
    );
    final olderY = tester
        .getTopLeft(find.byKey(const ValueKey('inbox-message-old:one')))
        .dy;
    final newerY = tester
        .getTopLeft(find.byKey(const ValueKey('inbox-message-you:voice:test')))
        .dy;
    expect(olderY, lessThan(newerY));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed reload keeps the last good page and reports it', (
    tester,
  ) async {
    final api = FeedGateway();
    await open(tester, api);
    expect(find.byKey(const ValueKey('inbox-message-final:test')), findsOneWidget);
    api.feedError = 'Feed unavailable.';
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('inbox-error')), findsOneWidget);
    expect(find.text('Feed unavailable.'), findsOneWidget);
    // The messages that were already loaded are still on screen.
    expect(find.byKey(const ValueKey('inbox-message-final:test')), findsOneWidget);
    api.feedError = null;
    await tester.tap(find.byKey(const ValueKey('inbox-retry')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('inbox-error')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('search re-queries the feed with the typed text', (tester) async {
    final api = FeedGateway();
    await open(tester, api);
    await tester.enterText(
      find.byKey(const ValueKey('inbox-search')),
      'pricing table',
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(api.feedRequests.last, contains('q=pricing%20table'));
    expect(tester.takeException(), isNull);
  });
}
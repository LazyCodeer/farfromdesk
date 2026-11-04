import 'package:flutter/material.dart';

import 'app.dart';
import 'gateway.dart';

void main() => runApp(
  FarFromDeskApp(
    gateway: PreviewGateway(
      fixture: Uri.base.queryParameters['fixture'] ?? 'empty',
      screen: Uri.base.queryParameters['screen'] ?? 'home',
    ),
  ),
);

/// UI-only development entry point. Never packaged as a desktop release.
class PreviewGateway extends Gateway {
  final String fixture, screen;
  PreviewGateway({this.fixture = 'onboarding', this.screen = 'home'}) {
    background = fixture != 'onboarding';
    setFlow(
      fixture == 'onboarding'
          ? 'whatsapp-setup'
          : fixture == 'connected' || fixture == 'activity'
          ? 'whatsapp-connected'
          : fixture,
    );
  }
  @override
  int get initialScreen => const [
    'home',
    'activity',
    'items',
    'brain',
    'settings',
    'email',
    'social',
  ].indexOf(screen).clamp(0, 6);
  String flow = 'empty';
  String whatsappState = 'disconnected';
  bool chosen = false;
  void setFlow(String value) {
    const flows = [
      'empty',
      'whatsapp-setup',
      'whatsapp-qr',
      'whatsapp-connected',
      'telegram',
      'telegram-pairing',
      'telegram-confirm',
      'telegram-connected',
      'telegram-expired',
      'telegram-error',
      'telegram-offline',
    ];
    flow = flows.contains(value) ? value : 'whatsapp-connected';
    chosen = flow != 'empty';
    controlChannel = flow.startsWith('telegram') ? 'telegram' : 'whatsapp';
    whatsappState = flow == 'whatsapp-connected'
        ? 'connected'
        : flow == 'whatsapp-qr'
        ? 'pairing'
        : 'disconnected';
    telegramState = switch (flow) {
      'telegram-connected' => 'connected',
      'telegram-pairing' => 'pairing',
      'telegram-confirm' => 'confirm',
      'telegram-expired' => 'pairing expired',
      _ => 'disconnected',
    };
  }

  @override
  Future<void> previewFlow(String flow) async {
    setFlow(flow);
  }

  String controlChannel = 'whatsapp';
  String telegramState = 'disconnected';
  final calls = <String>[];
  bool background = false, startup = false;
  @override
  bool get preview => true;
  @override
  String get platform => 'Sample desktop';
  // Sample memory folder for the Brain page preview.
  final Map<String, dynamic> memory = {
    'dir': '/Users/you/Library/Application Support/FarFromDesk/memory',
    'files': [
      {
        'path': 'MEMORY.md',
        'always': true,
        'content': '# Memory index\nRead this first. Open a file below only when the message needs it.\n\n- [About you](about-me.md): name, what to call you and the brain, reply style\n- [Words and names](words.md): terms, repos and people you mention\n- [Preferences](preferences.md): when to message you, how much detail\n- [Collaboration](collaboration.md): which platform or session handles which kind of work\n- [Website](projects/website.md): opened when a message is about this project\n',
      },
      {
        'path': 'about-me.md',
        'always': true,
        'content': '# About you\n- Name: Sam\n- Call me: Sam\n- Call the brain: Desk\n- Replies: short, English or Hinglish is fine\n',
      },
      {
        'path': 'collaboration.md',
        'always': true,
        'content': '# Collaboration\nWhich platform or session handles which kind of work.\n\n- Planning and review: Codex\n- Coding: Claude\n- Website redesign: website-codex session\n',
      },
      {
        'path': 'preferences.md',
        'always': false,
        'content':
            '# Preferences\n- Message me only when work is done or needs me.\n',
      },
      {
        'path': 'projects/website.md',
        'always': false,
        'content': '# Website\n- Staging is staging.example.com\n',
      },
      {
        'path': 'words.md',
        'always': false,
        'content': '# Words and names\n- ATC means the air-traffic-control repo.\n- Priya reviews design changes.\n',
      },
    ],
    'history': [
      {
        'id': 2,
        'at': DateTime.now()
            .subtract(const Duration(days: 1))
            .millisecondsSinceEpoch,
        'path': 'words.md',
        'source': 'brain:wa:2',
        'summary': 'Saved "Priya reviews design changes." in words.md',
      },
      {
        'id': 1,
        'at': DateTime.now()
            .subtract(const Duration(days: 2))
            .millisecondsSinceEpoch,
        'path': 'about-me.md',
        'source': 'brain:wa:1',
        'summary': 'Saved "Replies: short, English or Hinglish is fine" in about-me.md',
      },
    ],
    'intro': 'done',
  };
  @override
  Future<Map<String, dynamic>> get(String path) async =>
      path.startsWith('/api/inbox-feed')
      ? inboxFeed(path)
      : path == '/api/memory'
      ? memory
      : path == '/api/meta-timeline'
      ? {'scope': 'preview', 'events': <Object>[]}
      : {
          'metaTimelineScope': 'preview',
          'channelChosen': chosen,
          'channelSwitch': {
            'channel': controlChannel,
            'requiresConfirmation': controlChannel == 'telegram'
                ? telegramState != 'disconnected'
                : whatsappState != 'disconnected',
            'state':
                (controlChannel == 'telegram'
                        ? telegramState
                        : whatsappState) ==
                    'connected'
                ? 'connected'
                : (controlChannel == 'telegram'
                          ? telegramState
                          : whatsappState) ==
                      'disconnected'
                ? 'none'
                : 'setup',
          },
          'previewFlow': flow,
          'controlChannel': controlChannel,
          'telegram': {
            'status': telegramState,
            'configured':
                flow == 'telegram-offline' || telegramState != 'disconnected',
            'username': 'ffd_sample_bot',
            // The backend only stores an owner id after the account is confirmed.
            if (telegramState != 'pairing' && telegramState != 'confirm')
              'ownerId': '123456789',
            'ownerName': 'Alex',
            if (flow == 'telegram-error') 'error': 'Telegram could not connect. Check your bot token and internet connection, then try again.',
            if (flow == 'telegram-offline') 'error': 'Telegram could not complete the request. Check your connection and try again.',
            if (flow == 'telegram-expired') 'error': 'This pairing link expired. Reconnect to get a new private link.',
            if (telegramState == 'pairing')
              'pairingUrl': 'https://t.me/ffd_sample_bot?start=preview',
            if (telegramState == 'confirm')
              'candidate': {'id': 123456789, 'name': 'Alex'},
          },
          'preferences': {'backgroundEnabled': background, 'keepAwake': false},
          'whatsapp': {
            'status': whatsappState,
            if (whatsappState == 'pairing') 'qr': previewQr,
            // Only a paired account reports a number, matching the backend.
            if (whatsappState == 'connected') 'phoneNumber': '+15551234567',
          },
          'destination': {'kind': 'self', 'name': 'Message yourself'},
          'master': flow == 'empty' || fixture == 'onboarding'
              ? null
              : {
                  'id': 'sample-master',
                  'name': 'FarFromDesk coordinator',
                  'provider': 'codex',
                  'executionMode': 'cli',
                },
          'apps': [
            {'provider': 'codex', 'enabled': true},
            {'provider': 'claude', 'enabled': true},
          ],
          'requestCleanup': {'enabled': false, 'afterHours': 24},
          'voice': {'ready': fixture != 'onboarding'},
          'selected': [],
          'jobs': fixture == 'activity'
              ? [
                  {
                    'id': 'sample-reply',
                    'binding_id': 'sample-worker',
                    'status': 'completed',
                    'created_at': 1792911600000,
                  },
                ]
              : [],
          'bindings': [
            {
              'id': 'sample-worker',
              'name': 'Website redesign',
              'provider': 'codex',
              'native_id': 'sample-exact-session',
              'cwd': '/sample/projects/website',
            },
          ],
          'pendingJobs': fixture == 'activity'
              ? [
                  {
                    'id': 'sample-request',
                    'binding_id': 'sample-worker',
                    'status': 'uncertain',
                    'canClose': true,
                    'created_at': 1792911400000,
                    'updated_at': 1792911450000,
                  },
                ]
              : [],
          'approvals': [],
          'workItems': fixture == 'activity'
              ? [
                  {
                    'id': 7,
                    'title': 'Approve the build for the hero fix',
                    'session': 'Website redesign',
                    'status': 'waiting on owner',
                  },
                  {
                    'id': 6,
                    'title': 'Fix hero spacing on mobile',
                    'session': 'Website redesign',
                    'status': 'in progress',
                  },
                  {'id': 8, 'title': 'Draft release notes', 'status': 'open'},
                  {
                    'id': 4,
                    'title': 'Bump the Flutter SDK',
                    'session': 'Website redesign',
                    'status': 'done',
                  },
                ]
              : [],
          'masterSetup': {
            'platforms': [
              for (final provider in ['codex', 'claude'])
                {
                  'provider': provider,
                  'executionMode': 'cli',
                  'available': true,
                  'workspaces': [
                    {
                      'id': '$provider-sample-workspace',
                      'cwd': '/sample/projects/project-1',
                      'name': 'project-1',
                      'available': true,
                    },
                  ],
                  'sessions': List.generate(
                    63,
                    (i) => {
                      'id': '$provider-sample-$i',
                      'name': i == 0 ? 'Website redesign' : 'Project ${i + 1}',
                      'cwd': '/sample/projects/project-${i + 1}',
                      'available': true,
                      'status': 'Sample saved conversation',
                    },
                  ),
                },
              for (final provider in ['codex', 'claude'])
                {
                  'provider': provider,
                  'executionMode': 'desktop',
                  'available': false,
                  'sessions': [],
                  'reason': 'Desktop delivery is not supported by this adapter. Choose an exact saved CLI session.',
                },
            ],
          },
        };
    /// The unified Inbox, from canned data, so the design preview shows the real
  /// pane without a backend. No invented voice duration: the bridge's audio
  /// table stores none, so the preview shows what the app will really show.
  Map<String, dynamic> inboxFeed(String path) {
    final uri = Uri.parse(path);
    final view = uri.queryParameters['view'] ?? 'all';
    final query = (uri.queryParameters['q'] ?? '').toLowerCase();
    final before = int.tryParse(uri.queryParameters['beforeAt'] ?? '');
    final now = DateTime.now();
    final start = DateTime(now.year, now.month, now.day, 7, 55);
    int at(int minutes) =>
        start.add(Duration(minutes: minutes)).millisecondsSinceEpoch;

    Map<String, dynamic> delivery(String state, [int? minutes]) => {
      'state': state,
      if (minutes != null) 'at': at(minutes),
    };
    final messages = <Map<String, dynamic>>[
      {
        'key': '0:request:preview-app',
        'at': at(0),
        'source': 'you',
        'kind': 'voice',
        'channel': 'whatsapp',
        'origin': 'app',
        'text': 'Ask Codex to fix the pricing table on the pricing page. It overflows on a phone.',
        'delivery': delivery('delivered', 4),
        'requestId': 'wa:preview',
      },
      {
        'key': '1:routing:preview',
        'at': at(6),
        'source': 'brain',
        'kind': 'routing',
        'text': 'Routed to Website redesign (Codex). No other session matched.',
      },
      {
        'key': '2:working:preview',
        'at': at(9),
        'source': 'coordinator',
        'provider': 'codex',
        'bindingId': 'alpha',
        'sessionName': 'Website redesign',
        'kind': 'working',
        'kindLabel': 'Working',
        'text': 'Confirming the fix at 375 px and 320 px before I call it done.',
        'delivery': delivery('sent'),
        'requestId': 'wa:preview',
      },
      {
        'key': '3:update:preview',
        'at': at(17),
        'source': 'coordinator',
        'provider': 'claude',
        'bindingId': 'beta',
        'sessionName': 'Docs pass',
        'kind': 'update',
        'kindLabel': 'Update',
        'text': 'Pagination reference updated. One naming question is open.',
        'delivery': delivery('delivered', 18),
        'requestId': 'wa:docs',
      },
      {
        'key': '4:final:preview',
        'at': at(20),
        'source': 'coordinator',
        'provider': 'codex',
        'bindingId': 'alpha',
        'sessionName': 'Website redesign',
        'itemRef': 3,
        'kind': 'final',
        'kindLabel': 'Final',
        'text': 'No overflow at 375 px or 320 px. Nothing else changed.',
        'delivery': delivery('delivered', 32),
        'requestId': 'wa:preview',
      },
      {
        'key': '5:attention:preview',
        'at': at(24),
        'source': 'attention',
        'kind': 'attention',
        'kindLabel': 'Voice note · routing blocked',
        'text':
            'Transcript saved, but the original WhatsApp chat could not be routed.',
        'requestId': 'wa:preview',
        'bindingId': 'unassigned-voice',
        'destination': 'original-owner',
        'canReviewOrphan': 1,
        'needsReview': true,
      },
      {
        'key': '6:command:preview',
        'at': at(28),
        'source': 'command',
        'kind': 'command',
        'kindLabel': 'Command',
        'text': '2 requests open. Nothing is waiting on you.',
      },
    ];
    final history = <Map<String, dynamic>>[
      {
        'key': '0:request:preview-old',
        'at': at(-720),
        'source': 'you',
        'kind': 'text',
        'channel': 'whatsapp',
        'text': 'Start with the pricing table when you get a moment.',
        'delivery': delivery('delivered', -714),
      },
      {
        'key': '1:reply:preview-old',
        'at': at(-700),
        'source': 'coordinator',
        'provider': 'codex',
        'bindingId': 'alpha',
        'sessionName': 'Website redesign',
        'kind': 'update',
        'kindLabel': 'Update',
        'text': 'Earlier reply kept for the record.',
        'delivery': delivery('delivered', -699),
      },
    ];
    final views = <Map<String, dynamic>>[
      {
        'id': 'all',
        'kind': 'all',
        'name': 'One conversation',
        'detail': null,
        'count': 34,
        'needsYou': 2,
        'latestAt': at(28),
        'preview': 'Ask Codex to fix the pricing table...',
      },
      {
        'id': 'you',
        'kind': 'you',
        'name': 'You',
        'detail': null,
        'count': 12,
        'latestAt': at(0),
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
        'count': 6,
        'latestAt': at(17),
        'preview': 'Pagination reference updated...',
      },
      {
        'id': 'brain',
        'kind': 'brain',
        'name': 'Brain',
        'detail': null,
        'count': 1,
        'latestAt': null,
        'preview': '',
      },
      {
        'id': 'brain-brief',
        'kind': 'brain',
        'name': 'Morning brief',
        'detail': null,
        'count': 1,
        'latestAt': null,
        'preview': '3 requests open, 1 waiting on you',
      },
      {
        'id': 'brain-memory',
        'kind': 'brain',
        'name': 'Memory',
        'detail': null,
        'count': 2,
        'latestAt': null,
        'preview': 'Saved 2 notes to about-me.md...',
      },
      {
        'id': 'commands',
        'kind': 'command',
        'name': 'Status',
        'detail': null,
        'count': 3,
        'latestAt': at(28),
        'preview': '2 requests open. Nothing is waiting...',
      },
      {
        'id': 'attention',
        'kind': 'attention',
        'name': 'Needs you',
        'detail': null,
        'count': 2,
        'needsYou': 2,
        'latestAt': at(24),
        'preview': '',
      },
    ];
    final filtered = switch (view) {
      'you' => messages.where((m) => m['source'] == 'you').toList(),
      'coordinators' => messages
          .where((m) => m['source'] == 'coordinator')
          .toList(),
      'alpha' || 'beta' => messages
          .where((m) => m['bindingId'] == view)
          .toList(),
      'brain' => messages.where((m) => m['source'] == 'brain').toList(),
      'commands' => messages.where((m) => m['source'] == 'command').toList(),
      'attention' => messages
          .where((m) => m['source'] == 'attention')
          .toList(),
      _ => messages,
    };
    final rows = [
      for (final m in before == null ? filtered : history)
        if (query.isEmpty ||
            '${m['text']}'.toLowerCase().contains(query) ||
            '${m['sessionName'] ?? ''}'.toLowerCase().contains(query))
          m,
    ];
    final current =
        views.where((v) => v['id'] == view).firstOrNull ??
        (view == 'coordinators'
            ? <String, dynamic>{
                'id': 'coordinators',
                'kind': 'coordinator',
                'name': 'Coordinators',
                'count': 14,
              }
            : views.where((v) => v['id'] == 'all').firstOrNull ??
                  <String, dynamic>{});
    return {
      'view': {
        ...current,
        'firstAt': rows.isEmpty ? null : rows.first['at'],
        'lastAt': rows.isEmpty ? null : rows.last['at'],
      },
      'views': views,
      // Every group, counted globally, exactly as the bridge reports them. The
      // chip row reads these, so a group with nothing in it still shows 0.
      'filters': const [
        {'id': 'all', 'label': 'All', 'count': 34},
        {'id': 'you', 'label': 'You', 'count': 12},
        {'id': 'coordinators', 'label': 'Coordinators', 'count': 14},
        {'id': 'brain', 'label': 'Brain', 'count': 4},
        {'id': 'commands', 'label': 'Commands', 'count': 3},
        {'id': 'attention', 'label': 'Needs you', 'count': 2},
      ],
      'messages': rows,
      'next': before != null || rows.isEmpty
          ? null
          : {'at': rows.first['at'], 'key': '${rows.first['key']}'},
      'stats': {
        'total': 34,
        'firstAt': at(0),
        'lastAt': at(28),
        'needsYou': 2,
      },
    };
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    calls.add(path);
    if (path.startsWith('/api/memory')) return memory;
    if (path == '/api/control-channel') {
      setFlow(data['channel'] == 'telegram' ? 'telegram' : 'whatsapp-setup');
    }
    if (path == '/api/telegram/connect') setFlow('telegram-pairing');
    if (path == '/api/telegram/confirm') setFlow('telegram-connected');
    if (path == '/api/telegram/disconnect') setFlow('telegram');
    if (path == '/api/control-channel/disconnect') {
      setFlow(controlChannel == 'telegram' ? 'telegram' : 'whatsapp-setup');
    }
    if (path == '/api/connect') setFlow('whatsapp-qr');
    if (path == '/api/preferences') background = data['backgroundEnabled'];
    return {};
  }

  @override
  Future<void> openTelegram(Uri uri) async {
    if (uri.queryParameters.containsKey('start')) setFlow('telegram-confirm');
  }

  @override
  Future<String?> chooseFile(String label) async => null;
  @override
  Future<Map<String, dynamic>> readDocument(String path) async => {};
  @override
  Future<bool> startupEnabled() async => startup;
  @override
  Future<void> setStartup(bool enabled) async {
    startup = enabled;
  }
}

const previewQr =
    "data:image/png;base64,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";

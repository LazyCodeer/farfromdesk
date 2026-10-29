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
  ].indexOf(screen).clamp(0, 4);
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
  Future<Map<String, dynamic>> get(String path) async => path == '/api/memory'
      ? memory
      : path == '/api/meta-timeline'
      ? {'events': <Object>[]}
      : {
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
            'configured': telegramState != 'disconnected',
            'username': 'ffd_sample_bot',
            'ownerId': '123456789',
            'ownerName': 'Alex',
            if (flow == 'telegram-error') 'error': 'Telegram could not connect. Check your bot token and internet connection, then try again.',
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
            'phoneNumber': '+15551234567',
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

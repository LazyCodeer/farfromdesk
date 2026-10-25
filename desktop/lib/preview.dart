import 'package:flutter/material.dart';

import 'app.dart';
import 'gateway.dart';

void main() => runApp(
  FarFromDeskApp(
    gateway: PreviewGateway(
      fixture: Uri.base.queryParameters['fixture'] ?? 'onboarding',
      screen: Uri.base.queryParameters['screen'] ?? 'home',
    ),
  ),
);

/// UI-only development entry point. Never packaged as a desktop release.
class PreviewGateway extends Gateway {
  final String fixture, screen;
  PreviewGateway({this.fixture = 'onboarding', this.screen = 'home'}) {
    background = fixture != 'onboarding';
  }
  @override
  int get initialScreen => screen == 'activity'
      ? 1
      : screen == 'settings'
      ? 2
      : 0;
  final calls = <String>[];
  bool background = false, startup = false;
  @override
  bool get preview => true;
  @override
  String get platform => 'Sample desktop';
  @override
  Future<Map<String, dynamic>> get(String path) async => {
    'preferences': {'backgroundEnabled': background, 'keepAwake': false},
    'whatsapp': {
      'status': fixture == 'onboarding' ? 'Not connected' : 'connected',
      'phoneNumber': '+15551234567',
    },
    'destination': {'kind': 'self', 'name': 'Message yourself'},
    'master': fixture == 'onboarding'
        ? null
        : {
            'id': 'sample-master',
            'name': 'WhatsApp master',
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
    'masterSetup': {
      'platforms': [
        for (final provider in ['codex', 'claude'])
          {
            'provider': provider,
            'executionMode': 'cli',
            'available': true,
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
    if (path == '/api/preferences') background = data['backgroundEnabled'];
    return {};
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

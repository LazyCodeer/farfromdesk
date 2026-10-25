import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';
import 'package:farfromdesk/updates.dart';

void main() {
  setUpAll(() async {
    final font = FontLoader('DMSans')
      ..addFont(rootBundle.load('assets/DMSans.ttf'));
    await font.load();
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
  });
  void size(WidgetTester tester) {
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets(
    'Selected private group loads on startup, retries failures, and switches',
    (tester) async {
      size(tester);
      final api = GroupsGateway()..fail = true;
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(api.loads, 1);
      expect(find.textContaining('Could not load groups.'), findsOneWidget);
      expect(
        find.text('No groups with only you as a member were found.'),
        findsNothing,
      );
      expect(find.text('Review in Activity'), findsNothing);
      api.fail = false;
      await tester.ensureVisible(find.text('Refresh groups'));
      await tester.tap(find.text('Refresh groups'));
      await tester.pumpAndSettle();
      expect(api.loads, 2);
      expect(find.text('In use'), findsOneWidget);
      expect(find.text('My notes'), findsOneWidget);
      await tester.ensureVisible(find.text('Use this group'));
      await tester.tap(find.text('Use this group'));
      await tester.pumpAndSettle();
      expect(api.destination, 'notes@g.us');
      expect(find.text('In use'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Creation dialog refreshes native progress and clears the spinner on failure',
    (tester) async {
      size(tester);
      final api = SetupProgressGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Manage coordinators'));
      await tester.tap(find.text('Manage coordinators'));
      await tester.pumpAndSettle();
      api.creating = true;
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      final dialog = find.byType(Dialog);
      expect(
        find.descendant(
          of: dialog,
          matching: find.byType(CircularProgressIndicator),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: dialog,
          matching: find.text('Waiting for Claude to start the session'),
        ),
        findsOneWidget,
      );
      expect(find.textContaining('claude desktop ·'), findsNothing);
      api.creating = false;
      api.failed = true;
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: dialog,
          matching: find.byType(CircularProgressIndicator),
        ),
        findsNothing,
      );
      expect(
        find.descendant(
          of: dialog,
          matching: find.text('Native approval required'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: dialog,
          matching: find.text('Recover exact session'),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Settings disclosures use rounded cards and expand without bright dividers',
    (tester) async {
      size(tester);
      await tester.pumpWidget(FarFromDeskApp(gateway: ConnectionGateway()));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
      for (final title in [
        'Keep your computer available',
        'Your account & permissions',
        'Voice notes',
      ]) {
        await tester.scrollUntilVisible(
          find.text(title),
          250,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(find.text(title));
        await tester.pumpAndSettle();
        final tile = tester.widget<ExpansionTile>(
          find.ancestor(
            of: find.text(title),
            matching: find.byType(ExpansionTile),
          ),
        );
        expect(tile.shape, isA<RoundedRectangleBorder>());
        expect(tile.shape, tile.collapsedShape);
        expect(tester.takeException(), isNull);
      }
      if (Platform.environment['FFD_CAPTURE_SETTINGS'] == '1') {
        await Scrollable.ensureVisible(
          tester.element(find.text('Access & availability')),
          alignment: 0,
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byType(Scaffold),
          matchesGoldenFile('../../.local/settings-cards.png'),
        );
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'First-use voice setup shows download progress, retry and readiness',
    (tester) async {
      size(tester);
      final api = VoiceDownloadGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Download voice model · 141 MB'));
      await tester.tap(find.text('Download voice model · 141 MB'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Downloading voice model ·'), findsOneWidget);
      api.phase = 'failed';
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.text('Retry voice download'), findsOneWidget);
      api.phase = 'ready';
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.text('Voice notes ready'), findsOneWidget);
      expect(find.text('Retry voice download'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Instructions render Markdown in a larger dialog with a close icon',
    (tester) async {
      size(tester);
      await tester.pumpWidget(FarFromDeskApp(gateway: InstructionsGateway()));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('View instructions'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('View instructions'));
      await tester.pumpAndSettle();
      expect(find.text('Coordinator instructions'), findsOneWidget);
      expect(find.text('Version secret-version'), findsNothing);
      expect(find.text('internal-agent-name'), findsNothing);
      expect(find.text('Done'), findsNothing);
      expect(find.textContaining('# Sample heading'), findsNothing);
      expect(find.textContaining('Sample heading'), findsOneWidget);
      expect(tester.getSize(find.byType(Dialog)).width, greaterThan(560));
      expect(find.byTooltip('Close instructions'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byTooltip('Close instructions'));
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Activity presents request summaries and supports search and recovery guidance',
    (tester) async {
      size(tester);
      final api = ActivityDesignGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.text('FarFromDesk'), findsOneWidget);
      expect(find.text('Connected'), findsNothing);
      expect(find.byTooltip('Refresh'), findsNothing);
      expect(find.text('Check delivery after reconnecting'), findsOneWidget);
      expect(find.text('How recovery works'), findsOneWidget);
      if (Platform.environment['FFD_CAPTURE_ACTIVITY'] == '1') {
        await expectLater(
          find.byType(Scaffold),
          matchesGoldenFile('../../.local/activity-redesign.png'),
        );
      }
      await tester.enterText(
        find.widgetWithText(TextField, 'Search requests'),
        'reconnecting',
      );
      await tester.pumpAndSettle();
      expect(find.text('Check delivery after reconnecting'), findsOneWidget);
      expect(find.text('Review the website changes'), findsNothing);
      await tester.tap(find.text('How recovery works'));
      await tester.pumpAndSettle();
      expect(find.text('Your requests stay saved'), findsOneWidget);
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets('Activity request expansion remains bounded and interactive', (
    tester,
  ) async {
    size(tester);
    final api = ActivityDesignGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    final row = find.byKey(const PageStorageKey('request-wa:sample-wait'));
    await tester.ensureVisible(row);
    await tester.tap(find.text('Review the website changes'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(tester.getSize(row).height, lessThan(450));
    await tester.ensureVisible(find.text('Timing and delivery'));
    await tester.tap(find.text('Timing and delivery'));
    await tester.pumpAndSettle();
    expect(find.text('Request timing and delivery'), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Done'),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(row);
    await tester.tap(find.text('Review the website changes'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Review the website changes'));
    await tester.pumpAndSettle();
    expect(tester.getSize(row).height, lessThan(450));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'Header branding, grouped filters and visible selection work together',
    (tester) async {
      size(tester);
      final api = ActivityDesignGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      final logo = find.byKey(const ValueKey('header-logo'));
      expect(
        tester.getTopLeft(logo).dx,
        lessThan(tester.getTopLeft(find.text('FarFromDesk')).dx),
      );
      expect(tester.getTopLeft(logo).dy, lessThan(52));
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('navigation-rail'))).dy,
        lessThan(80),
      );
      final group = find.byKey(const ValueKey('activity-filter-group'));
      final waiting = find.descendant(
        of: group,
        matching: find.text('Waiting'),
      );
      await tester.ensureVisible(waiting);
      final target = find
          .ancestor(of: waiting, matching: find.byType(InkWell))
          .first;
      await tester.tapAt(tester.getTopLeft(target) + const Offset(4, 4));
      await tester.pumpAndSettle();
      expect(find.text('Check delivery after reconnecting'), findsNothing);
      final select = find.byKey(const ValueKey('select-visible-requests'));
      await tester.tap(select);
      await tester.pumpAndSettle();
      expect(find.text('Close selected (1)…'), findsOneWidget);
      expect(tester.widget<Checkbox>(select).value, true);
      await tester.tap(select);
      await tester.pumpAndSettle();
      expect(find.text('Close selected (1)…'), findsNothing);
      expect(api.calls, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Update banner stays in the top bar and automatic installation requires a click',
    (tester) async {
      tester.view.physicalSize = const Size(900, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = UpdateGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      for (final page in ['Home', 'Activity', 'Settings']) {
        await tester.tap(find.byTooltip(page));
        await tester.pumpAndSettle();
        expect(find.text('Update available'), findsOneWidget);
        expect(
          tester.getTopLeft(find.text('Update available')).dy,
          lessThan(52),
        );
        expect(
          tester.getTopLeft(find.text('Update available')).dx,
          greaterThan(650),
        );
        expect(find.byTooltip('Refresh'), findsNothing);
        expect(tester.takeException(), isNull);
      }
      expect(api.opened, isEmpty);
      await tester.tap(find.text('Update available'));
      await tester.pumpAndSettle();
      expect(find.text('Version 0.8.0'), findsOneWidget);
      await tester.tap(find.text('Later'));
      await tester.pumpAndSettle();
      expect(api.opened, isEmpty);
      await tester.tap(find.text('Update available'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Update and restart'));
      await tester.pumpAndSettle();
      expect(api.opened, isEmpty);
      expect(api.installs, 1);
      expect(find.text('Update could not finish'), findsOneWidget);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);
      await tester.pumpWidget(const SizedBox());
      expect(api.closed, true);
    },
  );
  testWidgets(
    'Activity exposes blocked voice routing and fetches diagnostics only on demand',
    (tester) async {
      size(tester);
      final api = AuditGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.text('Voice notes needing attention'), findsOneWidget);
      expect(find.text('Transcribed · routing blocked'), findsOneWidget);
      expect(api.diagnosticCalls, isEmpty);
      await tester.ensureVisible(find.text('Details'));
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      expect(find.text('Request timing and delivery'), findsOneWidget);
      expect(find.textContaining('voice_route_failed'), findsOneWidget);
      expect(find.textContaining('Delivered: Not observed'), findsOneWidget);
      expect(api.diagnosticCalls, ['/api/request-events?id=wa%3Avoice']);
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Build-41 shell and pairing consent preserve the existing design and authorization',
    (tester) async {
      size(tester);
      final api = PreviewGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.text('FarFromDesk'), findsWidgets);
      expect(find.byTooltip('Refresh'), findsNothing);
      expect(find.text('FarFromDesk / Home'), findsNothing);
      expect(find.text('Pair your phone'), findsOneWidget);
      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
      expect(
        Theme.of(tester.element(find.byWidget(scaffold)))
            .scaffoldBackgroundColor,
        const Color(0xff17181d),
      );
      await tester.tap(find.text('Connect WhatsApp'));
      await tester.pumpAndSettle();
      expect(
        find.text('Allow background access and connect WhatsApp?'),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);
      await tester.tap(find.text('Connect WhatsApp'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Allow and connect'));
      await tester.pumpAndSettle();
      expect(
        api.calls,
        containsAllInOrder(['/api/preferences', '/api/connect']),
      );
      await tester.ensureVisible(find.text('Use existing session'));
      await tester.tap(find.text('Use existing session'));
      await tester.pumpAndSettle();
      expect(find.text('63 saved chats'), findsOneWidget);
      await tester.enterText(find.byType(TextField).first, 'Website');
      await tester.pumpAndSettle();
      expect(find.text('1 saved chats'), findsOneWidget);
      await tester.tap(find.text('Website redesign'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Use selected session'));
      await tester.tap(find.text('Use selected session'));
      await tester.pumpAndSettle();
      expect(find.textContaining('codex-sample-0'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.calls, isNot(contains('/api/master-select')));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Connected Home, master dialog, Activity filters and Settings match the shared screen structure',
    (tester) async {
      size(tester);
      await tester.pumpWidget(
        FarFromDeskApp(gateway: PreviewGateway(fixture: 'connected')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Where should replies appear?'), findsOneWidget);
      await tester.ensureVisible(find.text('Manage coordinators'));
      await tester.tap(find.text('Manage coordinators'));
      await tester.pumpAndSettle();
      expect(find.text('Choose an existing session'), findsOneWidget);
      await tester.tap(find.text('Create new session'));
      await tester.pumpAndSettle();
      expect(find.text('Automatic'), findsOneWidget);
      expect(find.text('FarFromDesk · Codex CLI'), findsOneWidget);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Activity'));
      await tester.pumpAndSettle();
      expect(find.text('Request history'), findsOneWidget);
      expect(find.text('Select all'), findsOneWidget);
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
      expect(find.text('Run in the background'), findsOneWidget);
      expect(find.text('Open at login'), findsOneWidget);
      expect(find.text('Coding apps'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Minimum native window has no layout overflow on all three screens',
    (tester) async {
      tester.view.physicalSize = const Size(900, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        FarFromDeskApp(gateway: PreviewGateway(fixture: 'activity')),
      );
      await tester.pumpAndSettle();
      for (final page in ['Activity', 'Settings', 'Home']) {
        await tester.tap(find.byTooltip(page));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Platform selection keeps CLI account status separate and requires a workspace',
    (tester) async {
      size(tester);
      final api = ConnectionGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Manage coordinators'));
      await tester.tap(find.text('Manage coordinators'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Create new session'));
      await tester.pumpAndSettle();
      expect(find.text('Test CLI account'), findsOneWidget);
      await tester.tap(
        find
            .descendant(
              of: find.byType(Dialog),
              matching: find.byType(DropdownButton<String>),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Claude CLI').last);
      await tester.pumpAndSettle();
      expect(find.text('CLI signed out · sign in to this CLI'), findsWidgets);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Create coordinator'),
            )
            .onPressed,
        isNull,
      );
      await tester.tap(
        find
            .descendant(
              of: find.byType(Dialog),
              matching: find.byType(DropdownButton<String>),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Claude Desktop').last);
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Uses the selected desktop chat’s account · identity not exposed',
        ),
        findsOneWidget,
      );
      expect(find.text('Workspace'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Create coordinator'),
            )
            .onPressed,
        isNull,
      );
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('/sample/personal').last);
      await tester.pumpAndSettle();
      if (Platform.environment['FFD_CAPTURE_SETUP'] == '1') {
        await expectLater(
          find.byType(Dialog),
          matchesGoldenFile('../../.local/workspace-setup.png'),
        );
      }
      await tester.ensureVisible(find.text('Create coordinator'));
      await tester.tap(find.text('Create coordinator'));
      await tester.pumpAndSettle();
      expect(api.submitted?['provider'], 'claude');
      expect(api.submitted?['executionMode'], 'desktop');
      expect(api.submitted?['workspaceId'], 'workspace-personal');
      expect(api.submitted!.containsKey('desktopParentId'), isFalse);
      expect(api.submitted?['connectionRevision'], 'desktop-revision');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Home saves Desktop immediately without a launcher or session picker',
    (tester) async {
      size(tester);
      final api = PreferenceGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      final codex = find.byKey(const ValueKey('platform-runtime-codex'));
      final claude = find.byKey(const ValueKey('platform-runtime-claude'));
      await tester.ensureVisible(codex);
      expect(tester.widget<DropdownButton<String>>(codex).value, isNull);
      await tester.tap(codex);
      await tester.pumpAndSettle();
      await tester.tap(find.text('CLI').last);
      await tester.pumpAndSettle();
      expect(api.saved['codex']?['executionMode'], 'cli');
      expect(tester.widget<DropdownButton<String>>(codex).value, 'cli');
      await tester.ensureVisible(claude);
      await tester.tap(claude);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<DropdownButton<String>>(claude)
            .items!
            .singleWhere((i) => i.value == 'cli')
            .enabled,
        false,
      );
      await tester.tap(find.text('Desktop').last);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('Choose Claude Desktop launcher'), findsNothing);
      expect(api.saved['claude']?['executionMode'], 'desktop');
      expect(api.saved['claude']!.containsKey('desktopParentId'), false);
      expect(api.saved['claude']?['connectionRevision'], 'desktop-revision');
      expect(api.saved['codex']?['executionMode'], 'cli');
      expect(api.calls, everyElement('/api/platform-preference'));
      expect(api.calls.length, 2);
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Home'));
      await tester.pumpAndSettle();
      expect(tester.widget<DropdownButton<String>>(codex).value, 'cli');
      expect(tester.widget<DropdownButton<String>>(claude).value, 'desktop');
      expect(tester.takeException(), isNull);
      if (Platform.environment['FFD_CAPTURE_PLATFORMS'] == '1') {
        await tester.ensureVisible(find.text('Coding platforms'));
        await tester.pumpAndSettle();
        await expectLater(
          find.byType(Scaffold),
          matchesGoldenFile('../../.local/platform-preferences.png'),
        );
      }
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Multiple coordinators change default without replacing a session',
    (tester) async {
      size(tester);
      final api = MultiCoordinatorGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Your coordinators'));
      await tester.pumpAndSettle();
      expect(find.text('Claude project coordinator'), findsOneWidget);
      expect(find.text('Codex project coordinator'), findsOneWidget);
      await tester.ensureVisible(find.text('Make default'));
      await tester.tap(find.text('Make default'));
      await tester.pumpAndSettle();
      expect(api.defaultId, 'claude-coordinator');
      expect(api.changes, 1);
      expect(find.text('Codex project coordinator'), findsOneWidget);
      expect(find.text('Claude project coordinator'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

class PreferenceGateway extends ConnectionGateway {
  final saved = <String, Map<String, dynamic>>{};
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['platformPreferences'] = saved.values.toList();
    for (final option in data['masterSetup']['platforms']) {
      if (option['provider'] == 'claude') option['sessions'] = [];
    }
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/platform-preference') {
      saved[data['provider']] = {
        ...data,
        'connectionLabel':
            'Selected ${data['provider']} ${data['executionMode']} account',
        if (data['desktopParentId'] != null)
          'launcherName': 'Personal desktop chat',
      };
    }
    return super.post(path, data);
  }
}

class AuditGateway extends PreviewGateway {
  AuditGateway() : super(fixture: 'activity', screen: 'activity');
  final diagnosticCalls = <String>[];
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path.startsWith('/api/request-events')) {
      diagnosticCalls.add(path);
      return {
        'events': [
          {
            'event': 'voice_route_failed',
            'at': 1792911400000,
            'details': '{"code":"routing_unavailable"}',
          },
        ],
        'deliveries': [
          {
            'status': 'sent',
            'reply_kind': 'final',
            'attempts': 0,
            'sent_at': 1792911400000,
          },
        ],
      };
    }
    final data = await super.get(path);
    data['voiceRequests'] = [
      {
        'id': 'wa:voice',
        'status': 'routing_blocked',
        'created_at': 1792911400000,
      },
    ];
    return data;
  }
}

class UpdateGateway extends PreviewGateway {
  UpdateGateway() : super(fixture: 'connected');
  final opened = <Uri>[];
  int installs = 0;
  @override
  bool get canInstallUpdate => true;
  @override
  Future<void> installUpdate(
    AppRelease release,
    void Function(Map<String, dynamic>) progress,
  ) async {
    installs++;
    progress({
      'phase': 'downloading',
      'message': 'Downloading update…',
      'received': 1,
      'total': 10,
    });
    throw StateError('Test download interrupted; app retained.');
  }

  bool closed = false;
  @override
  Future<UpdateCheck> checkUpdates({bool manual = false}) async => UpdateCheck(
    release: AppRelease(
      '0.8.0',
      Uri.parse(
        'https://github.com/LazyCodeer/farfromdesk/releases/download/v0.8.0/FarFromDesk-0.8.0-macos-arm64.zip',
      ),
      Uri.parse(
        'https://github.com/LazyCodeer/farfromdesk/releases/tag/v0.8.0',
      ),
      400000000,
    ),
  );
  @override
  Future<void> openReleasePage(Uri uri) async {
    opened.add(uri);
  }

  @override
  void closeUpdates() {
    closed = true;
  }
}

class ActivityDesignGateway extends PreviewGateway {
  ActivityDesignGateway() : super(fixture: 'activity', screen: 'activity');
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['pendingJobs'] = [
      {
        'id': 'wa:sample-review',
        'binding_id': 'sample-worker',
        'status': 'uncertain',
        'canClose': true,
        'created_at': 1792911450000,
        'preview': 'Check delivery after reconnecting',
      },
      {
        'id': 'wa:sample-wait',
        'binding_id': 'sample-worker',
        'status': 'submitted',
        'canClose': true,
        'created_at': 1792911400000,
        'preview': 'Review the website changes',
      },
      {
        'id': 'wa:sample-queue',
        'binding_id': 'sample-worker',
        'status': 'queued',
        'created_at': 1792911300000,
        'preview': 'Run the release checks',
      },
    ];
    data['jobs'] = [
      {
        'id': 'wa:sample-done',
        'binding_id': 'sample-worker',
        'status': 'completed',
        'outcome': 'done',
        'created_at': 1792911200000,
        'preview': 'Summarize the latest changes',
      },
      {
        'id': 'wa:sample-closed',
        'binding_id': 'sample-worker',
        'status': 'reviewed',
        'created_at': 1792911000000,
        'preview': 'Check the previous build',
      },
    ];
    return data;
  }
}

class ConnectionGateway extends PreviewGateway {
  ConnectionGateway() : super(fixture: 'connected');
  Map<String, dynamic>? submitted;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    for (final p in data['masterSetup']['platforms']) {
      final desktop = p['executionMode'] == 'desktop';
      final signedOut = p['provider'] == 'claude' && !desktop;
      p['available'] = true;
      p['canCreate'] = !signedOut;
      p['connection'] = {
        'state': desktop
            ? 'native'
            : signedOut
            ? 'signed-out'
            : 'verified',
        'label': desktop
            ? 'Uses the selected desktop chat’s account · identity not exposed'
            : signedOut
            ? 'CLI signed out · sign in to this CLI'
            : 'Test CLI account',
        'revision': desktop ? 'desktop-revision' : 'cli-revision',
      };
      if (desktop) {
        p['workspaces'] = [
          for (final name in ['personal', 'work'])
            {
              'id': 'workspace-$name',
              'cwd': '/sample/$name',
              'name': name,
              'available': true,
            },
        ];
        p['sessions'] = [
          {
            'id': 'desktop-personal',
            'name': 'Personal desktop chat',
            'cwd': '/sample/personal',
            'available': true,
          },
          {
            'id': 'desktop-work',
            'name': 'Work desktop chat',
            'cwd': '/sample/work',
            'available': true,
          },
        ];
      }
    }
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/master-create') submitted = Map.from(data);
    return super.post(path, data);
  }
}

class MultiCoordinatorGateway extends ConnectionGateway {
  String defaultId = 'codex-coordinator';
  int changes = 0;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['coordinators'] = [
      for (final provider in ['codex', 'claude'])
        {
          'bindingId': '$provider-coordinator',
          'provider': provider,
          'executionMode': 'desktop',
          'name': provider == 'codex'
              ? 'Codex project coordinator'
              : 'Claude project coordinator',
          'enabled': true,
          'isDefault': defaultId == '$provider-coordinator',
        },
    ];
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/coordinators/default') {
      defaultId = data['bindingId'];
      changes++;
      return {};
    }
    throw StateError('Unexpected action: $path');
  }
}

class InstructionsGateway extends MultiCoordinatorGateway {
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['masterSetup'] = Map<String, dynamic>.from(data['masterSetup']);
    data['masterSetup']['prompt'] =
        '# Sample heading\n\nA **clear instruction**.\n\n- A useful step';
    data['masterSetup']['roleDelivery'] = {
      'state': 'sent',
      'policyVersion': 'secret-version',
      'agentName': 'internal-agent-name',
    };
    return data;
  }
}

class GroupsGateway extends ConnectionGateway {
  bool fail = false;
  int loads = 0;
  String destination = 'bridge@g.us';
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/group-recover') {
      loads++;
      if (fail) throw StateError('Connection interrupted');
      return {
        'groups': [
          {'id': 'bridge@g.us', 'name': 'Session Bridge'},
          {'id': 'notes@g.us', 'name': 'My notes'},
        ],
      };
    }
    final data = await super.get(path);
    data['destination'] = {
      'jid': destination,
      'kind': 'group',
      'name': destination == 'bridge@g.us' ? 'Session Bridge' : 'My notes',
    };
    data['pendingJobs'] = [
      {'id': 'pending', 'status': 'uncertain'},
    ];
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/destination') {
      destination = data['jid'];
      return {};
    }
    return super.post(path, data);
  }
}

class SetupProgressGateway extends ConnectionGateway {
  bool creating = false, failed = false;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['masterSetup'] = Map<String, dynamic>.from(data['masterSetup']);
    if (creating || failed) {
      data['masterSetup']['operation'] = {
        'id': 'setup-test',
        'provider': 'claude',
        'executionMode': 'desktop',
        'name': 'FarFromDesk · Claude Desktop',
        'status': creating ? 'creating' : 'uncertain',
        'stage': 'Waiting for Claude to start the session',
        if (failed) 'error': 'Native approval required',
      };
    }
    return data;
  }
}

class VoiceDownloadGateway extends ConnectionGateway {
  String phase = 'needed';
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['voice'] = {
      'ready': phase == 'ready',
      if (phase != 'ready')
        'download': {
          'state': phase,
          'bytes': phase == 'downloading' ? 74000000 : 0,
          'total': 147951465,
          if (phase == 'failed') 'error': 'Download interrupted. Try again.',
        },
    };
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/voice-model') {
      phase = 'downloading';
      return {};
    }
    return super.post(path, data);
  }
}

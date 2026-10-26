import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/bridge_theme.dart';
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
  void calm(WidgetTester tester) {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
  }

  void size(WidgetTester tester) {
    calm(tester);
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets(
    'Unconfigured messaging choice switches both ways without a disconnect dialog',
    (tester) async {
      size(tester);
      final api = PreviewGateway(fixture: 'empty');
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(
        find.text('Your coding sessions,\none message away.'),
        findsOneWidget,
      );
      expect(find.byType(SegmentedButton<String>), findsNothing);
      await tester.tap(find.text('Continue with Telegram'));
      await tester.pumpAndSettle();
      expect(api.chosen, isTrue);
      expect(api.controlChannel, 'telegram');
      await tester.tap(find.text('Choose another app'));
      await tester.pumpAndSettle();
      expect(find.text('Switch to WhatsApp?'), findsNothing);
      expect(find.text('Disconnect and switch'), findsNothing);
      expect(api.controlChannel, 'whatsapp');
      expect(find.text('Connect your WhatsApp'), findsOneWidget);
      await tester.tap(find.text('Choose another app'));
      await tester.pumpAndSettle();
      expect(api.controlChannel, 'telegram');
      expect(find.text('Switch to Telegram?'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Unfinished bot pairing asks to cancel setup and cancel preserves it',
    (tester) async {
      size(tester);
      final api = PreviewGateway(fixture: 'telegram-pairing');
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Choose another app'));
      await tester.pumpAndSettle();
      expect(find.text('Cancel setup and switch'), findsOneWidget);
      expect(find.textContaining('unfinished Telegram setup'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.controlChannel, 'telegram');
      expect(api.telegramState, 'pairing');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Every connection flow renders without layout overflow', (
    tester,
  ) async {
    size(tester);
    tester.view.physicalSize = const Size(900, 720);
    for (final flow in [
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
    ]) {
      await tester.pumpWidget(
        FarFromDeskApp(
          key: ValueKey(flow),
          gateway: PreviewGateway(fixture: flow),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(tester.takeException(), isNull, reason: flow);
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    }
  });

  testWidgets(
    'Telegram setup selects the channel, pairs, confirms and disconnects',
    (tester) async {
      size(tester);
      final api = PreviewGateway(fixture: 'connected');
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Messaging settings').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Use Telegram'));
      await tester.pumpAndSettle();
      expect(find.text('Switch to Telegram?'), findsOneWidget);
      await tester.tap(find.text('Disconnect and switch'));
      await tester.pumpAndSettle();
      expect(api.controlChannel, 'telegram');
      expect(find.text('Connect Telegram'), findsWidgets);
      expect(find.text('Where should replies appear?'), findsNothing);
      final field = find.widgetWithText(TextField, 'Bot token');
      expect(tester.widget<TextField>(field).obscureText, isTrue);
      await tester.enterText(
        field,
        '123456:FAKE_TOKEN_FOR_TEST_ONLY_1234567890',
      );
      await tester.ensureVisible(find.text('Connect bot'));
      await tester.tap(find.text('Connect bot'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.text('Waiting for you in Telegram'), findsOneWidget);
      expect(api.calls, contains('/api/telegram/connect'));
      await tester.tap(find.text('Open Telegram'));
      await tester.pumpAndSettle();
      expect(find.text('Confirm your Telegram account'), findsOneWidget);
      await tester.tap(find.text('Confirm this account'));
      await tester.pumpAndSettle();
      expect(find.text('@ffd_sample_bot'), findsOneWidget);
      expect(find.textContaining('Secret Chats'), findsOneWidget);
      expect(find.text('Where should replies appear?'), findsNothing);
      await tester.tap(find.text('Messaging settings').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Use WhatsApp'));
      await tester.pumpAndSettle();
      expect(find.text('Switch to WhatsApp?'), findsOneWidget);
      await tester.tap(find.text('Disconnect and switch'));
      await tester.pumpAndSettle();
      expect(api.controlChannel, 'whatsapp');
      expect(api.telegramState, 'disconnected');
      expect(find.text('Connect your WhatsApp'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Home disconnect is explicit and Settings shows both messaging apps',
    (tester) async {
      size(tester);
      final api = PreviewGateway(fixture: 'telegram-connected');
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.text('Switch app'), findsNothing);
      expect(
        find.image(const AssetImage('assets/logo-telegram.png')),
        findsOneWidget,
      );
      await tester.tap(find.text('Disconnect'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.telegramState, 'connected');
      await tester.tap(find.text('Messaging settings').first);
      await tester.pumpAndSettle();
      expect(find.text('Messaging app'), findsOneWidget);
      expect(find.text('Not connected'), findsOneWidget);
      expect(find.text('Use WhatsApp'), findsOneWidget);
      await tester.tap(find.byTooltip('Home'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Disconnect'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Disconnect'),
        ),
      );
      await tester.pumpAndSettle();
      expect(api.controlChannel, 'telegram');
      expect(api.telegramState, 'disconnected');
      expect(api.calls, contains('/api/control-channel/disconnect'));
      expect(find.text('Not connected'), findsWidgets);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Telegram home fits a smaller desktop without a WhatsApp QR or group picker',
    (tester) async {
      size(tester);
      tester.view.physicalSize = const Size(900, 720);
      await tester.pumpWidget(
        FarFromDeskApp(gateway: PreviewGateway(fixture: 'telegram-connected')),
      );
      await tester.pumpAndSettle();
      expect(find.text('@ffd_sample_bot'), findsOneWidget);
      expect(find.text('Show QR code'), findsNothing);
      expect(find.text('Where should replies appear?'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

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
      expect(
        find.textContaining('Replies go to Session Bridge.'),
        findsOneWidget,
      );
      await tester.ensureVisible(find.text('My notes'));
      await tester.tap(find.text('My notes'));
      await tester.pumpAndSettle();
      expect(api.destination, 'notes@g.us');
      expect(find.textContaining('Replies go to My notes.'), findsOneWidget);
      expect(find.text('In use'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Voice notes set up from Home with a local download or an API key',
    (tester) async {
      size(tester);
      final api = VoiceGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.text('Set up voice notes'), findsOneWidget);
      await tester.ensureVisible(find.text('Download voice model · 141 MB'));
      await tester.tap(find.text('Download voice model · 141 MB'));
      await tester.pumpAndSettle();
      expect(api.posts.containsKey('/api/voice-model'), isTrue);
      await tester.tap(find.text('Use an API key'));
      await tester.pumpAndSettle();
      expect(find.textContaining('not affiliated'), findsNothing);
      expect(find.textContaining('isn\'t affiliated'), findsOneWidget);
      expect(find.text('console.deepgram.com'), findsOneWidget);
      await tester.tap(find.text('AssemblyAI'));
      await tester.pumpAndSettle();
      expect(find.text('www.assemblyai.com/dashboard'), findsOneWidget);
      await tester.tap(find.text('Deepgram'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField).last,
        'dg_abcdefghijklmnopqrstuvwxyza91f',
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Save and test'));
      await tester.tap(find.text('Save and test'));
      await tester.pumpAndSettle();
      expect(api.posts['/api/voice-engine'], {
        'engine': 'deepgram',
        'key': 'dg_abcdefghijklmnopqrstuvwxyza91f',
      });
      expect(
        find.textContaining(
          'Transcribed by Deepgram with your key ending a91f',
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Groups load once WhatsApp finishes connecting', (tester) async {
    size(tester);
    final api = GroupsGateway()..linked = false;
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pump(const Duration(milliseconds: 500));
    expect(api.loads, 0);
    expect(find.textContaining('Could not load groups.'), findsNothing);
    api.linked = true;
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(api.loads, 1);
    expect(find.text('My notes'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Preparation failure does not mark the project step complete', (
    tester,
  ) async {
    size(tester);
    final api = SetupProgressGateway()
      ..failed = true
      ..stage = 'Preparing workspace';
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Manage coordinators'));
    await tester.tap(find.text('Manage coordinators'));
    await tester.pumpAndSettle();
    final step = find.descendant(
      of: find.byType(Dialog),
      matching: find.widgetWithText(Row, 'Prepare the coordinator folder'),
    );
    expect(step, findsWidgets);
    expect(
      find.descendant(of: step, matching: find.byIcon(Icons.check)),
      findsNothing,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'Waiting setup guides the native Start and collapses earlier attempts',
    (tester) async {
      size(tester);
      final api = SetupProgressGateway()..waiting = true;
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      Finder inDialog(String text) => find.text(text);
      expect(inDialog('Start your session in Claude'), findsOneWidget);
      expect(inDialog('Open Claude'), findsOneWidget);
      expect(inDialog('Recover exact session'), findsNothing);
      expect(find.textContaining('task_12345678'), findsNothing);
      expect(inDialog('Start the session in Claude'), findsOneWidget);
      expect(inDialog('Create Claude Desktop coordinator'), findsNothing);
      expect(inDialog('Earlier setup attempts (1)'), findsOneWidget);
      expect(inDialog('Earlier Claude coordinator'), findsNothing);
      await tester.ensureVisible(inDialog('Earlier setup attempts (1)'));
      await tester.tap(inDialog('Earlier setup attempts (1)'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(inDialog('Earlier Claude coordinator'));
      expect(inDialog('Earlier Claude coordinator'), findsOneWidget);
      expect(inDialog('Recover exact session'), findsOneWidget);
      await tester.ensureVisible(inDialog('Choose another setup'));
      await tester.tap(inDialog('Choose another setup'));
      await tester.pumpAndSettle();
      final dialog = find.byType(Dialog);
      Finder inDialogOnly(String text) =>
          find.descendant(of: dialog, matching: find.text(text));
      expect(find.byKey(const ValueKey('coordinator-folder')), findsOneWidget);
      expect(inDialogOnly('Add a coordinator'), findsOneWidget);
      expect(inDialog('Use existing session'), findsOneWidget);
      expect(inDialog('Create Codex CLI coordinator'), findsOneWidget);
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
        findsWidgets,
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
    'Coordinator manager shows only coordinator management and keeps the close control',
    (tester) async {
      size(tester);
      await tester.pumpWidget(
        FarFromDeskApp(gateway: MultiCoordinatorGateway()),
      );
      await tester.pumpAndSettle();
      expect(find.text('Instructions'), findsNothing);
      await tester.ensureVisible(find.text('Manage coordinators'));
      await tester.tap(find.text('Manage coordinators'));
      await tester.pumpAndSettle();
      expect(find.text('Instructions'), findsNothing);
      expect(find.text('Connected sessions'), findsNothing);
      expect(find.text('Copy instructions'), findsNothing);
      expect(find.text('+ Add coordinator'), findsOneWidget);
      expect(find.text('Make default'), findsOneWidget);
      expect(find.text('Change'), findsNWidgets(2));
      expect(find.byTooltip('Close'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byTooltip('Close'));
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
        find.widgetWithText(TextField, 'Search requests or sessions'),
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
      await tester.tap(waiting);
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
      calm(tester);
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
          tester.getTopLeft(find.text('Update available')).dx,
          lessThan(216),
        );
        expect(find.byTooltip('Refresh'), findsNothing);
        expect(tester.takeException(), isNull);
      }
      expect(api.opened, isEmpty);
      await tester.tap(find.text('Update now').first);
      await tester.pumpAndSettle();
      expect(find.text('Version 0.8.0'), findsOneWidget);
      await tester.tap(find.text('Later'));
      await tester.pumpAndSettle();
      expect(api.opened, isEmpty);
      await tester.tap(find.text('Update now').first);
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
      expect(find.text('Connect your WhatsApp'), findsOneWidget);
      expect(find.text('Set up a coordinator'), findsOneWidget);
      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
      expect(
        Theme.of(tester.element(find.byWidget(scaffold)))
            .scaffoldBackgroundColor,
        windowColor,
      );
      await tester.tap(find.text('Show QR code').last);
      await tester.pumpAndSettle();
      expect(
        find.text('Allow background access and connect WhatsApp?'),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);
      await tester.tap(find.text('Show QR code').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Allow and connect'));
      await tester.pumpAndSettle();
      expect(
        api.calls,
        containsAllInOrder(['/api/preferences', '/api/connect']),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Existing session picker searches saved chats and confirms before selecting',
    (tester) async {
      size(tester);
      final api = PreviewGateway(fixture: 'connected');
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Manage coordinators'));
      await tester.tap(find.text('Manage coordinators'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('+ Add coordinator'));
      await tester.pumpAndSettle();
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
      expect(find.text('Instructions'), findsNothing);
      expect(find.text('Connected sessions'), findsNothing);
      await tester.tap(find.text('+ Add coordinator'));
      await tester.pumpAndSettle();
      expect(find.text('Add a coordinator'), findsOneWidget);
      expect(find.text('Use existing session'), findsOneWidget);
      expect(find.text('Edit'), findsNothing);
      expect(find.text('Use automatic'), findsNothing);
      final nameField = find.byKey(const ValueKey('coordinator-name'));
      expect(
        tester.widget<TextField>(nameField).controller!.text,
        'FarFromDesk Orbit · Codex CLI',
      );
      await tester.tap(find.text('Codex Desktop'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(nameField).controller!.text,
        'FarFromDesk Orbit · Codex Desktop',
      );
      await tester.enterText(nameField, 'Mission Control');
      await tester.tap(find.text('Claude Desktop'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(nameField).controller!.text,
        'Mission Control',
      );
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Activity'));
      await tester.pumpAndSettle();
      expect(find.text('Request history'), findsOneWidget);
      expect(find.text('Select all'), findsNothing);
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
      expect(find.text('Run in the background'), findsOneWidget);
      expect(find.text('Open at login'), findsOneWidget);
      expect(find.text('Coding apps'), findsNothing);
      expect(find.text('App updates'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'Minimum native window has no layout overflow on all three screens',
    (tester) async {
      calm(tester);
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
    'Platform selection keeps CLI account status separate and creates in the coordinator folder',
    (tester) async {
      size(tester);
      final api = ConnectionGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Manage coordinators'));
      await tester.tap(find.text('Manage coordinators'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('+ Add coordinator'));
      await tester.pumpAndSettle();
      expect(find.text('Test CLI account'), findsOneWidget);
      await tester.tap(
        find.descendant(
          of: find.byType(Dialog),
          matching: find.text('Claude CLI'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('CLI signed out · sign in to this CLI'), findsWidgets);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(
                FilledButton,
                'Create Claude CLI coordinator',
              ),
            )
            .onPressed,
        isNull,
      );
      await tester.tap(
        find.descendant(
          of: find.byType(Dialog),
          matching: find.text('Claude Desktop'),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Uses the selected desktop chat’s account · identity not exposed',
        ),
        findsOneWidget,
      );
      expect(
        find.text(
          '~/.farfromdesk/coordinators/farfromdesk-orbit-claude-desktop-…',
        ),
        findsOneWidget,
      );
      api.reversePlatforms = true;
      await tester.pump(const Duration(seconds: 4));
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.text('Create Claude Desktop coordinator'),
      );
      await tester.tap(find.text('Create Claude Desktop coordinator'));
      await tester.pumpAndSettle();
      expect(api.submitted?['name'], 'FarFromDesk Orbit · Claude Desktop');
      expect(api.submitted?['provider'], 'claude');
      expect(api.submitted?['executionMode'], 'desktop');
      expect(api.submitted!.containsKey('workspaceId'), isFalse);
      expect(api.submitted!.containsKey('desktopParentId'), isFalse);
      expect(api.submitted?['connectionRevision'], 'desktop-revision');
      expect(find.text('Create Claude Desktop coordinator'), findsNothing);
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
      await tester.tap(find.text('Codex CLI').last);
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
      await tester.tap(find.text('Claude Desktop').last);
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
      await tester.ensureVisible(find.text('Coordinators'));
      await tester.pumpAndSettle();
      expect(find.text('Claude project coordinator'), findsWidgets);
      expect(find.text('Codex project coordinator'), findsWidgets);
      await tester.ensureVisible(find.text('Manage coordinators'));
      await tester.tap(find.text('Manage coordinators'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Make default'));
      await tester.pumpAndSettle();
      expect(api.defaultId, 'claude-coordinator');
      expect(api.changes, 1);
      expect(find.text('Codex project coordinator'), findsWidgets);
      expect(find.text('Claude project coordinator'), findsWidgets);
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
  bool reversePlatforms = false;
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
    if (reversePlatforms) {
      data['masterSetup']['platforms'] = List.from(
        data['masterSetup']['platforms'].reversed,
      );
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
  bool fail = false, linked = true;
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
    if (!linked) data['whatsapp'] = {'status': 'connecting'};
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
  bool creating = false, failed = false, waiting = false;
  String stage = 'Waiting for Claude to start the session';
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['masterSetup'] = Map<String, dynamic>.from(data['masterSetup']);
    if (waiting) {
      data['masterSetup']['operation'] = {
        'id': 'setup-waiting',
        'provider': 'claude',
        'executionMode': 'desktop',
        'name': 'Current Claude coordinator',
        'status': 'needs_action',
        'proposalId': 'task_12345678',
        'error': 'Desktop start needs owner action: start the existing proposal task_12345678',
      };
      data['masterSetup']['attempts'] = [
        {
          'id': 'setup-earlier',
          'provider': 'claude',
          'executionMode': 'desktop',
          'name': 'Earlier Claude coordinator',
          'status': 'uncertain',
          'error': 'Native approval required',
        },
      ];
    } else if (creating || failed) {
      data['masterSetup']['operation'] = {
        'id': 'setup-test',
        'provider': 'claude',
        'executionMode': 'desktop',
        'name': 'FarFromDesk · Claude Desktop',
        'status': creating ? 'creating' : 'uncertain',
        'stage': stage,
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

class VoiceGateway extends ConnectionGateway {
  Map<String, dynamic> voice = {
    'ready': false,
    'local': true,
    'localReady': false,
    'engine': 'local',
    'fallback': true,
    'download': {'state': 'needed', 'bytes': 0, 'total': 147951465},
  };
  final posts = <String, Map<String, dynamic>>{};
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    data['voice'] = voice;
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/voice-engine' || path == '/api/voice-model') {
      posts[path] = data;
      if (data['engine'] == 'deepgram') {
        voice = {
          ...voice,
          'ready': true,
          'local': false,
          'engine': 'deepgram',
          'keyHint': 'a91f',
        };
      }
      return {};
    }
    return super.post(path, data);
  }
}

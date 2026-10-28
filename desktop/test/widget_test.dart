import 'dart:io';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/bridge_theme.dart';
import 'package:farfromdesk/preview.dart';
import 'package:farfromdesk/updates.dart';

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

  testWidgets('Onboarding shows a rejected Telegram token error', (
    tester,
  ) async {
    size(tester);
    final api = FailingTelegramGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Bot token'),
      '123456:synthetic_token_only_123456789012345',
    );
    await tester.ensureVisible(find.text('Connect bot'));
    await tester.tap(find.text('Connect bot'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('onboarding-error')), findsOneWidget);
    expect(find.text('Telegram rejected this bot token.'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Old item errors do not show setup while reconnecting', (
    tester,
  ) async {
    size(tester);
    final api = ReconnectingItemsGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    expect(find.textContaining('Could not load items.'), findsWidgets);
    for (final state in ['connecting', 'reconnecting']) {
      api.whatsappState = state;
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const Key('startup-loader')), findsOneWidget);
      expect(find.byKey(const Key('onboarding-error')), findsNothing);
    }
    api.whatsappState = 'connected';
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('startup-loader')), findsNothing);
    expect(find.textContaining('Could not load items.'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Phone stop interrupts pending work for both connection types', (
    tester,
  ) async {
    size(tester);
    for (final wifi in [false, true]) {
      final api = BusyRemoteGateway(wifi);
      await tester.pumpWidget(FarFromDeskApp(key: UniqueKey(), gateway: api));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('remote-password')));
      await tester.enterText(
        find.byKey(const Key('remote-password')),
        'synthetic remote password',
      );
      await tester.enterText(
        find.byKey(const Key('remote-password-confirm')),
        'synthetic remote password',
      );
      await tester.ensureVisible(find.byKey(const Key('remote-password-save')));
      await tester.tap(find.byKey(const Key('remote-password-save')));
      await tester.pump();
      final stop = find.byKey(Key(wifi ? 'wifi-stop' : 'remote-link-stop'));
      await tester.ensureVisible(stop);
      await tester.tap(stop);
      await tester.pump();
      expect(api.remoteActions, contains(wifi ? 'stop' : 'link-stop'));
      api.blocked.complete({});
      await tester.pumpAndSettle();
      expect(find.textContaining('superseded'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets(
    'Remote Desktop settings remain reachable to turn off saved access',
    (tester) async {
      size(tester);
      final api = LegacyRemoteGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      final entry = find.byKey(const Key('remote-desktop-settings'));
      await tester.ensureVisible(entry);
      await tester.tap(entry);
      await tester.pumpAndSettle();
      final toggle = find.widgetWithText(
        SwitchListTile,
        'Make this Mac available',
      );
      await tester.ensureVisible(toggle);
      expect(tester.widget<SwitchListTile>(toggle).value, isTrue);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(api.legacyEnabled, isFalse);
      expect(tester.widget<SwitchListTile>(toggle).value, isFalse);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Phone selectors clear removed values when equal-length lists refresh',
    (tester) async {
      size(tester);
      final api = RefreshingRemoteGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      Finder field(String label) => find.byWidgetPredicate(
        (w) => w is DropdownButtonFormField && w.decoration.labelText == label,
      );
      expect(
        tester
            .widget<DropdownButtonFormField<String>>(field('Wi-Fi network'))
            .initialValue,
        '192.0.2.1',
      );
      await tester.ensureVisible(find.byKey(const Key('wifi-find-apps')));
      await tester.tap(find.byKey(const Key('wifi-find-apps')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(field('App'));
      await tester.tap(field('App'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Editor One').last);
      await tester.pumpAndSettle();
      expect(
        tester.widget<DropdownButtonFormField<int>>(field('App')).initialValue,
        10,
      );
      api.replaced = true;
      await tester.tap(find.byKey(const Key('wifi-find-apps')));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(
        tester.widget<DropdownButtonFormField<int>>(field('App')).initialValue,
        isNull,
      );
      expect(
        tester
            .widget<DropdownButtonFormField<int>>(field('Window'))
            .initialValue,
        isNull,
      );
      expect(
        tester
            .widget<DropdownButtonFormField<String>>(field('Wi-Fi network'))
            .initialValue,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Inbox shows command failures even without native jobs', (
    tester,
  ) async {
    size(tester);
    await tester.pumpWidget(FarFromDeskApp(gateway: CommandHistoryGateway()));
    await tester.pumpAndSettle();
    expect(find.text('Recent commands'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('inbox-tab-Commands')));
    await tester.pumpAndSettle();
    expect(find.text('/claude'), findsWidgets);
    expect(find.text('Failed'), findsWidgets);
    expect(find.text('No connected Claude session.'), findsWidgets);
    expect(find.byKey(const ValueKey('activity-filter-group')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Mac control requires opt-in, separates permission setup and can stop immediately',
    (tester) async {
      size(tester);
      final api = MacControlGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      final toggle = find.byKey(const Key('mac-control-enabled'));
      await tester.ensureVisible(toggle);
      expect(tester.widget<Switch>(toggle).value, isFalse);
      expect(find.byKey(const Key('mac-open-permission')), findsNothing);
      expect(api.macActions, isEmpty);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      // Turning it on checks the permissions without a button press.
      expect(api.macActions, ['enable', 'check']);
      expect(find.byKey(const Key('mac-open-permission')), findsOneWidget);
      final check = find.byKey(const Key('mac-refresh-permission'));
      await tester.ensureVisible(check);
      await tester.tap(check);
      await tester.pumpAndSettle();
      expect(api.macActions, ['enable', 'check', 'check']);
      expect(find.text('Needs permission'), findsOneWidget);
      expect(find.text('Screen Recording'), findsOneWidget);
      final setup = find.byKey(const Key('mac-open-permission'));
      await tester.ensureVisible(setup);
      await tester.tap(setup);
      await tester.pumpAndSettle();
      expect(api.macActions.last, 'permission');
      final recording = find.byKey(const Key('mac-open-capture-permission'));
      await tester.ensureVisible(recording);
      await tester.tap(recording);
      await tester.pumpAndSettle();
      expect(api.macActions.last, 'capture-permission');
      await tester.ensureVisible(toggle);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(api.macActions.last, 'disable');
      expect(tester.widget<Switch>(toggle).value, isFalse);
      expect(find.text('Stop and turn off'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Remote control sets a password and stops an active link', (
    tester,
  ) async {
    size(tester);
    final api = MacControlGateway()..linkState = 'offered';
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    final field = find.byKey(const Key('remote-password'));
    await tester.ensureVisible(field);
    await tester.enterText(field, 'short');
    await tester.enterText(
      find.byKey(const Key('remote-password-confirm')),
      'short',
    );
    await tester.ensureVisible(find.byKey(const Key('remote-password-save')));
    await tester.tap(find.byKey(const Key('remote-password-save')));
    await tester.pumpAndSettle();
    expect(api.remoteActions, isEmpty);
    expect(find.textContaining('at least 12 characters'), findsWidgets);
    await tester.enterText(field, 'a long remote pass');
    await tester.enterText(
      find.byKey(const Key('remote-password-confirm')),
      'a long remote pass',
    );
    await tester.ensureVisible(find.byKey(const Key('remote-password-save')));
    await tester.tap(find.byKey(const Key('remote-password-save')));
    await tester.pumpAndSettle();
    expect(api.remoteActions, ['password']);
    expect(find.text('Change'), findsOneWidget);
    final stop = find.byKey(const Key('remote-link-stop'));
    await tester.ensureVisible(stop);
    await tester.tap(stop);
    await tester.pumpAndSettle();
    expect(api.remoteActions.last, 'link-stop');
    expect(stop, findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'Mac control shows Accessibility and Screen Recording separately',
    (tester) async {
      size(tester);
      final api = MacControlGateway()
        ..enabled = true
        ..trusted = true
        ..captureTrusted = true;
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Screen Recording'));
      expect(find.text('Allowed'), findsNWidgets(2));
      expect(
        find.byKey(const Key('mac-open-capture-permission')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

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
      await tester.tap(find.text('Telegram'));
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
      await tester.tap(find.byTooltip('Settings'));
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
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Secret Chats'), findsOneWidget);
      expect(find.text('Where should replies appear?'), findsNothing);
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

  testWidgets('Settings disconnect is explicit and shows both messaging apps', (
    tester,
  ) async {
    size(tester);
    final api = PreviewGateway(fixture: 'telegram-connected');
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    expect(find.text('Switch app'), findsNothing);
    await tester.tap(find.byTooltip('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Messaging app'), findsOneWidget);
    expect(find.text('Not connected'), findsOneWidget);
    expect(find.text('Use WhatsApp'), findsOneWidget);
    await tester.ensureVisible(find.text('Disconnect'));
    await tester.tap(find.text('Disconnect'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(api.telegramState, 'connected');
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
  });

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
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
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
      expect(find.text('dev.meta.ai'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('Meta')).dx,
        lessThan(tester.getTopLeft(find.text('Deepgram')).dx),
      );
      await tester.tap(find.text('Deepgram'));
      await tester.pumpAndSettle();
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

  testWidgets('Meta voice notes can reuse the Brain key without showing it', (
    tester,
  ) async {
    size(tester);
    final api = VoiceGateway()..brainKey = true;
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Use an API key'));
    await tester.tap(find.text('Use an API key'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Meta'));
    await tester.pumpAndSettle();
    expect(find.text('dev.meta.ai'), findsOneWidget);
    final reuse = find.byKey(const Key('voice-use-brain-key'));
    await tester.ensureVisible(reuse);
    await tester.tap(reuse);
    await tester.pumpAndSettle();
    expect(api.posts['/api/voice-engine'], {
      'engine': 'meta',
      'useBrainKey': true,
    });
    expect(find.textContaining('Transcribed by Meta'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

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
    await tester.tap(find.byTooltip('Settings'));
    await tester.pumpAndSettle();
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
      for (final title in ['Keep your computer available']) {
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
      expect(
        find.descendant(of: find.byType(Dialog), matching: find.text('Change')),
        findsNWidgets(2),
      );
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
      expect(find.text('Check delivery after reconnecting'), findsWidgets);
      expect(find.byTooltip('How recovery works'), findsOneWidget);
      if (Platform.environment['FFD_CAPTURE_ACTIVITY'] == '1') {
        await expectLater(
          find.byType(Scaffold),
          matchesGoldenFile('../../.local/activity-redesign.png'),
        );
      }
      await tester.enterText(
        find.widgetWithText(TextField, 'Search sessions'),
        'reconnecting',
      );
      await tester.pumpAndSettle();
      expect(find.text('Check delivery after reconnecting'), findsWidgets);
      // Search selects the whole matching session, retaining its other requests.
      expect(find.text('Review the website changes'), findsWidgets);
      await tester.tap(find.byTooltip('How recovery works'));
      await tester.pumpAndSettle();
      expect(find.text('Your requests stay saved'), findsOneWidget);
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets('Inbox tabs separate session history, commands and attention', (
    tester,
  ) async {
    size(tester);
    final api = SessionInboxGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    final a = find.byKey(const ValueKey('inbox-session-alpha'));
    final b = find.byKey(const ValueKey('inbox-session-beta'));
    expect(a, findsOneWidget);
    expect(b, findsOneWidget);
    expect(tester.getTopLeft(a).dy, lessThan(tester.getTopLeft(b).dy));
    expect(find.text('Shared session'), findsWidgets);
    expect(find.text('A full current request'), findsWidgets);
    expect(find.text('No speech was found.'), findsOneWidget);
    expect(find.text('Voice transcript'), findsOneWidget);
    expect(find.textContaining('Progress · Telegram'), findsOneWidget);
    expect(find.textContaining('Final · Telegram'), findsOneWidget);
    expect(
      find.textContaining('Worker report for owner request'),
      findsNothing,
    );
    expect(find.byType(Checkbox), findsNothing);
    expect(find.text('Mark reviewed'), findsNothing);
    expect(find.text('Request status'), findsNothing);
    if (Platform.environment['FFD_CAPTURE_SESSION_INBOX'] == '1') {
      await tester.runAsync(() async {
        for (final brand in ['claude', 'openai', 'whatsapp']) {
          await precacheImage(
            AssetImage('assets/logo-$brand.png'),
            tester.element(find.byType(Scaffold)),
          );
        }
      });
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(Scaffold),
        matchesGoldenFile('../../../inbox2308-session.png'),
      );
    }
    await tester.enterText(
      find.widgetWithText(TextField, 'Search sessions'),
      'needle reply',
    );
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();
    expect(a, findsOneWidget);
    expect(b, findsNothing);
    expect(find.text('A full current request'), findsWidgets);
    await tester.enterText(
      find.widgetWithText(TextField, 'Search sessions'),
      '',
    );
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('inbox-tab-Commands')));
    await tester.pumpAndSettle();
    expect(a, findsNothing);
    expect(find.byKey(const ValueKey('activity-filter-group')), findsNothing);
    expect(find.text('Ready for your next message.'), findsWidgets);
    expect(find.textContaining('💬'), findsNothing);
    expect(find.textContaining('*Reply*'), findsNothing);
    expect(find.textContaining('— FarFromDesk'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('inbox-tab-Attention')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('inbox-attention-request:tg:old')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('inbox-attention-delivery:failed')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('activity-filter-group')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'Earlier conversation pages and exact older request review remain available',
    (tester) async {
      size(tester);
      final api = SessionInboxGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Load earlier messages'));
      await tester.pumpAndSettle();
      expect(api.olderCalls, 1);
      expect(find.text('Earlier owner request to review'), findsOneWidget);
      expect(find.text('Load earlier messages'), findsNothing);
      await tester.tap(find.text('Session info'));
      await tester.pumpAndSettle();
      expect(find.text('/sample/alpha'), findsOneWidget);
      expect(find.text('alpha-native-id'), findsOneWidget);
      final infoScroll = find
          .descendant(
            of: find.byType(AlertDialog),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.scrollUntilVisible(
        find.byType(DropdownButtonFormField<String>),
        180,
        scrollable: infoScroll,
      );
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Earlier owner request to review').last);
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Mark reviewed'),
        180,
        scrollable: infoScroll,
      );
      await tester.drag(infoScroll, const Offset(0, -140));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mark reviewed'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirm').last);
      await tester.pumpAndSettle();
      expect(api.reviewed, [
        {
          'requestId': 'tg:old',
          'expectedStatus': 'uncertain',
          'confirmed': true,
        },
      ]);
      expect(find.text('Mark reviewed'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Late session loads never replace the selected conversation', (
    tester,
  ) async {
    size(tester);
    final api = SessionInboxGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    api.holdBeta = true;
    await tester.tap(find.byKey(const ValueKey('inbox-session-beta')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('inbox-session-alpha')));
    await tester.pumpAndSettle();
    api.betaPending.complete(api.thread('beta'));
    await tester.pumpAndSettle();
    expect(find.text('A full current request'), findsWidgets);
    expect(find.text('Only in the other session'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Same-timestamp refresh gaps keep earlier messages reachable', (
    tester,
  ) async {
    size(tester);
    final api = SameTimestampInboxGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    expect(find.text('Load earlier messages'), findsNothing);
    api.newPage = true;
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    final threadScroll = find
        .descendant(
          of: find.byKey(const PageStorageKey('inbox-thread-alpha')),
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(
      find.text('Load earlier messages'),
      -500,
      scrollable: threadScroll,
      maxScrolls: 50,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Load earlier messages'));
    await tester.pumpAndSettle();
    expect(api.olderCalls, 1);
    await tester.scrollUntilVisible(
      find.text('Recovered middle message'),
      -500,
      scrollable: threadScroll,
      maxScrolls: 50,
    );
    expect(find.text('Recovered middle message'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Compact Inbox opens session info without overflow', (
    tester,
  ) async {
    size(tester);
    tester.view.physicalSize = const Size(760, 720);
    final api = SessionInboxGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('inbox-session-alpha')));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Back to sessions'), findsOneWidget);
    await tester.tap(find.text('Session info'));
    await tester.pumpAndSettle();
    expect(find.text('/sample/alpha'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'Compact Inbox restores its list when the selected session no longer matches',
    (tester) async {
      size(tester);
      tester.view.physicalSize = const Size(760, 720);
      final api = SessionInboxGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('activity-filter-group')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Needs review').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('inbox-session-alpha')));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Back to sessions'), findsOneWidget);
      api.oldReviewed = true;
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('inbox-tab-Requests')), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Search sessions'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('activity-filter-group')),
        findsOneWidget,
      );
      expect(find.text('No matching sessions.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Inbox groups requests and keeps details in session info', (
    tester,
  ) async {
    size(tester);
    final api = ActivityDesignGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('inbox-session-sample-worker'));
    expect(row, findsOneWidget);
    expect(find.byType(Checkbox), findsNothing);
    expect(find.text('Select all'), findsNothing);
    expect(find.textContaining('Close selected'), findsNothing);
    expect(find.text('Review the website changes'), findsWidgets);
    expect(find.text('Mark reviewed'), findsNothing);
    await tester.tap(find.text('Session info'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Timing and delivery'),
      180,
      scrollable: find
          .descendant(
            of: find.byType(AlertDialog),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.tap(find.text('Timing and delivery'));
    await tester.pumpAndSettle();
    expect(find.text('Request timing and delivery'), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog).last,
        matching: find.text('Done'),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('Header filters sessions without bulk request selection', (
    tester,
  ) async {
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
    await tester.tap(find.byKey(const ValueKey('activity-filter-group')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Waiting').last);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('inbox-session-sample-worker')),
      findsOneWidget,
    );
    // One waiting request keeps all of that session's history visible.
    expect(find.text('Check delivery after reconnecting'), findsWidgets);
    expect(find.byKey(const ValueKey('select-visible-requests')), findsNothing);
    expect(find.byType(Checkbox), findsNothing);
    expect(api.calls, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
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
      for (final page in ['Overview', 'Inbox', 'Settings']) {
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
    'Attention shows the orphan voice error without reading another chat diagnostics',
    (tester) async {
      size(tester);
      final api = AuditGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.text('Voice notes needing attention'), findsNothing);
      expect(api.diagnosticCalls, isEmpty);
      await tester.tap(find.byKey(const ValueKey('inbox-tab-Attention')));
      await tester.pumpAndSettle();
      expect(find.text('Voice note · routing blocked'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('inbox-attention-voice:wa:voice')),
      );
      await tester.pumpAndSettle();
      final orphanThread = find.byKey(
        const PageStorageKey('inbox-thread-unassigned-voice'),
      );
      expect(orphanThread, findsOneWidget);
      expect(
        find.descendant(
          of: orphanThread,
          matching: find.text(AuditGateway.orphanError),
        ),
        findsOneWidget,
      );
      expect(find.text('Request timing and delivery'), findsNothing);
      expect(find.textContaining('PRIVATE OTHER DESTINATION'), findsNothing);
      expect(api.diagnosticCalls, isEmpty);
      expect(api.threadCalls, contains('unassigned-voice'));
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
      await tester.tap(find.text('Website redesign').last);
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
      await tester.tap(find.byTooltip('Inbox'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('activity-filter-group')),
        findsOneWidget,
      );
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
      for (final page in ['Inbox', 'Settings', 'Overview']) {
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
    'Settings saves Desktop immediately without a launcher or session picker',
    (tester) async {
      size(tester);
      final api = PreferenceGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Settings'));
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
      await tester.tap(find.byTooltip('Overview'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Settings'));
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
  static const orphanError =
      'Transcript saved, but the original WhatsApp chat could not be routed.';
  final diagnosticCalls = <String>[];
  final threadCalls = <String>[];
  static const at = 1792911400000;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path.startsWith('/api/request-events')) {
      diagnosticCalls.add(path);
      return {
        'events': [
          {
            'event': 'PRIVATE OTHER DESTINATION',
            'at': at,
            'details': 'Same request id belongs to another destination.',
          },
        ],
        'deliveries': [],
      };
    }
    if (path.startsWith('/api/inbox-thread')) {
      final id = Uri.parse(path).queryParameters['bindingId'];
      if (id == null) {
        return {
          'sessions': [
            {
              'id': 'sample-worker',
              'binding_id': 'sample-worker',
              'name': 'Separate session',
              'preview': 'Separate destination request',
              'latestAt': at + 1000,
              'requestCount': 1,
              'needsReview': 1,
              'waiting': 0,
              'answered': 0,
              'closed': 0,
            },
            {
              'id': 'unassigned-voice',
              'binding_id': null,
              'name': 'Unassigned voice notes',
              'preview': orphanError,
              'latestAt': at,
              'requestCount': 1,
              'needsReview': 1,
              'waiting': 0,
              'answered': 0,
              'closed': 0,
            },
          ],
          'attention': [
            {
              'id': 'voice:wa:voice',
              'bindingId': 'unassigned-voice',
              'requestId': 'wa:voice',
              'title': 'Voice note · routing blocked',
              'text': orphanError,
              'at': at,
              'destination': 'original-owner',
              'canReviewOrphan': 1,
            },
          ],
        };
      }
      threadCalls.add(id);
      if (id == 'unassigned-voice') {
        return {
          'messages': [
            {
              'key': '2:voice:wa:voice',
              'requestId': 'wa:voice',
              'kind': 'voice-failed',
              'text': orphanError,
              'at': at,
              'destination': 'original-owner',
              'voice': 1,
            },
          ],
          'jobs': [],
          'next': null,
        };
      }
      return {
        'messages': [
          {
            'key': '0:request:wa:voice',
            'requestId': 'wa:voice',
            'kind': 'owner',
            'text': 'Separate destination request',
            'at': at + 1000,
            'destination': 'different-owner',
            'voice': 0,
          },
        ],
        'jobs': [],
        'next': null,
      };
    }
    final data = await super.get(path);
    data['voiceRequests'] = [
      {'id': 'wa:voice', 'status': 'routing_blocked', 'created_at': at},
    ];
    // The orphan's id alone is insufficient: another chat can have that request id.
    data['pendingJobs'] = [
      {
        'id': 'wa:voice',
        'binding_id': 'sample-worker',
        'destination': 'different-owner',
        'status': 'uncertain',
        'created_at': at + 1000,
        'preview': 'Separate destination request',
      },
    ];
    data['jobs'] = [];
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
  bool brainKey = false;
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
    if (brainKey) data['metaBrain'] = {'enabled': true, 'configured': true};
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/voice-engine' || path == '/api/voice-model') {
      posts[path] = data;
      if (data['engine'] == 'deepgram' || data['engine'] == 'meta') {
        voice = {
          ...voice,
          'ready': true,
          'local': false,
          'engine': data['engine'],
          'keyHint': 'a91f',
        };
      }
      return {};
    }
    return super.post(path, data);
  }
}

class MacControlGateway extends PreviewGateway {
  MacControlGateway() : super(screen: 'settings');
  final macActions = <String>[];
  bool enabled = false;
  bool? trusted;
  bool? captureTrusted;
  Future<Map<String, dynamic>> status(String path) async {
    final data = await super.get(path);
    if (path == '/api/status') data['macControl'] = view;
    return data;
  }

  bool remotePasswordSet = false;
  String linkState = 'idle';
  final remoteActions = <String>[];
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/remote-control') return {'state': linkState};
    if (path == '/api/phone-remote') {
      return {
        'supported': true,
        'passwordSet': remotePasswordSet,
        'running': false,
        'addresses': [],
      };
    }
    return status(path);
  }

  Map<String, dynamic> get view => {
    'supported': true,
    'enabled': enabled,
    'trusted': trusted,
    'capture': {'supported': true, 'trusted': captureTrusted},
  };

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/phone-remote') {
      remoteActions.add(data['action'] as String);
      if (data['action'] == 'password') remotePasswordSet = true;
      return {};
    }
    if (path == '/api/remote-control') {
      remoteActions.add('link-stop');
      linkState = 'ended';
      return {'state': linkState};
    }
    if (path == '/api/mac-control') {
      macActions.add(data['action'] as String);
      if (data['action'] == 'enable') enabled = true;
      if (data['action'] == 'disable') enabled = false;
      if (data['action'] == 'check') {
        trusted ??= false;
        captureTrusted ??= false;
      }
      return view;
    }
    return super.post(path, data);
  }
}

class CommandHistoryGateway extends PreviewGateway {
  CommandHistoryGateway() : super(fixture: 'connected', screen: 'activity');
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    if (path == '/api/status') {
      data['jobs'] = [];
      data['pendingJobs'] = [];
      data['commandTurns'] = [
        {
          'id': 'tg:1:2:3',
          'label': '/claude',
          'status': 'blocked',
          'summary': 'No connected Claude session.',
        },
      ];
    }
    return data;
  }
}

class FailingTelegramGateway extends PreviewGateway {
  FailingTelegramGateway() : super(fixture: 'telegram');
  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/telegram/connect') {
      throw StateError('Telegram rejected this bot token.');
    }
    return super.post(path, data);
  }
}

class BusyRemoteGateway extends MacControlGateway {
  BusyRemoteGateway(bool wifi) : wifiRunning = wifi {
    linkState = wifi ? 'idle' : 'offered';
  }
  bool wifiRunning;
  final blocked = Completer<Map<String, dynamic>>();
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    if (path == '/api/phone-remote') data['running'] = wifiRunning;
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/phone-remote' && data['action'] == 'password') {
      remoteActions.add('password');
      return blocked.future;
    }
    if (path == '/api/phone-remote' && data['action'] == 'stop') {
      wifiRunning = false;
    }
    return super.post(path, data);
  }
}

class LegacyRemoteGateway extends MacControlGateway {
  bool legacyEnabled = true;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/remote-desktop') {
      return {'supported': true, 'enabled': legacyEnabled, 'passwordSet': true};
    }
    return super.get(path);
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/remote-desktop') {
      if (data['action'] == 'stop') legacyEnabled = false;
      return {'enabled': legacyEnabled};
    }
    return super.post(path, data);
  }
}

class RefreshingRemoteGateway extends MacControlGateway {
  RefreshingRemoteGateway() {
    enabled = true;
    trusted = true;
    captureTrusted = true;
    remotePasswordSet = true;
  }
  bool replaced = false;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    if (path == '/api/phone-remote') {
      data['addresses'] = [
        {'name': 'Wi-Fi', 'address': replaced ? '192.0.2.2' : '192.0.2.1'},
      ];
    }
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/phone-remote' && data['action'] == 'apps') {
      return {
        'apps': [
          {
            'pid': replaced ? 20 : 10,
            'name': replaced ? 'Editor Two' : 'Editor One',
          },
        ],
      };
    }
    if (path == '/api/phone-remote' && data['action'] == 'windows') {
      return {
        'windows': [
          {'id': 11, 'title': 'Window One'},
        ],
      };
    }
    return super.post(path, data);
  }
}

class ReconnectingItemsGateway extends PreviewGateway {
  ReconnectingItemsGateway() : super(fixture: 'connected');
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/meta-brain/tasks') {
      throw StateError('Items temporarily unavailable.');
    }
    return super.get(path);
  }
}

class SessionInboxGateway extends PreviewGateway {
  SessionInboxGateway() : super(fixture: 'activity', screen: 'activity');
  bool holdBeta = false;
  final betaPending = Completer<Map<String, dynamic>>();
  int olderCalls = 0;
  final reviewed = <Map<String, dynamic>>[];
  bool oldReviewed = false;
  static const now = 1793232000000;
  List<Map<String, dynamic>> get testJobs => [
    {
      'id': 'tg:old',
      'binding_id': 'alpha',
      'status': oldReviewed ? 'reviewed' : 'uncertain',
      'canClose': !oldReviewed,
      'created_at': now - 86400000,
      'updated_at': now - 86400000,
      'body': 'Earlier owner request to review',
      'preview': 'Earlier owner request to review',
      'error': oldReviewed ? null : 'Check the original session.',
      'destination': 'tg:owner',
    },
    {
      'id': 'tg:new',
      'binding_id': 'alpha',
      'status': 'completed',
      'outcome': 'done',
      'created_at': now,
      'updated_at': now + 5000,
      'body': 'A full current request',
      'preview': 'A full current request',
      'destination': 'tg:owner',
    },
    {
      'id': 'tg:beta',
      'binding_id': 'beta',
      'status': 'completed',
      'outcome': 'done',
      'created_at': now + 10000,
      'updated_at': now + 10000,
      'body': 'Only in the other session',
      'preview': 'Only in the other session',
      'destination': 'tg:owner',
    },
  ];
  Map<String, dynamic> thread(String id, {bool older = false}) {
    if (id == 'beta') {
      return {
        'messages': [
          {
            'key': 'request:tg:beta',
            'requestId': 'tg:beta',
            'kind': 'owner',
            'text': 'Only in the other session',
            'at': now + 10000,
            'destination': 'tg:owner',
            'voice': 0,
          },
        ],
        'jobs': testJobs.where((j) => j['binding_id'] == 'beta').toList(),
        'next': null,
      };
    }
    if (older) {
      return {
        'messages': [
          {
            'key': 'request:tg:old',
            'requestId': 'tg:old',
            'kind': 'owner',
            'text': 'Earlier owner request to review',
            'at': now - 86400000,
            'destination': 'tg:owner',
            'voice': 0,
          },
        ],
        'jobs': [testJobs.first],
        'next': null,
      };
    }
    return {
      'messages': [
        {
          'key': 'request:tg:new',
          'requestId': 'tg:new',
          'kind': 'owner',
          'text': 'A full current request',
          'at': now,
          'destination': 'tg:owner',
          'voice': 1,
        },
        {
          'key': 'reply:progress',
          'requestId': 'tg:new',
          'kind': 'progress',
          'text': 'Working through the checks.',
          'at': now + 1000,
          'destination': 'tg:owner',
          'voice': 0,
        },
        {
          'key': 'reply:final',
          'requestId': 'tg:new',
          'kind': 'final',
          'text': 'Found the needle reply.',
          'at': now + 2000,
          'destination': 'tg:owner',
          'voice': 0,
        },
        {
          'key': 'report:worker',
          'requestId': 'tg:new',
          'kind': 'worker-report',
          'text': 'Worker report for owner request tg:8856686568:999. Ignore header.\n\nWorker tests passed.',
          'at': now + 3000,
          'destination': 'tg:owner',
          'voice': 0,
        },
        {
          'key': 'voice:failed',
          'requestId': 'tg:new',
          'kind': 'voice-failed',
          'text': 'No speech was found.',
          'at': now + 4000,
          'destination': 'tg:owner',
          'voice': 1,
        },
      ],
      'jobs': testJobs.where((j) => j['binding_id'] == 'alpha').toList(),
      'next': {'at': now, 'id': 'request:tg:new'},
    };
  }

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path.startsWith('/api/inbox-thread')) {
      final uri = Uri.parse(path);
      final id = uri.queryParameters['bindingId'];
      if (id == null) {
        final q = (uri.queryParameters['q'] ?? '').toLowerCase();
        return {
          'sessions': [
            if (q.isEmpty ||
                'shared session needle reply earlier owner'.contains(q))
              {
                'id': 'alpha',
                'binding_id': 'alpha',
                'name': 'Shared session',
                'requestCount': 2,
                'latestAt': now + 5000,
                'preview': 'Found the needle reply.',
                'needsReview': oldReviewed ? 0 : 1,
                'waiting': 0,
                'answered': 1,
                'closed': oldReviewed ? 1 : 0,
              },
            if (q.isEmpty)
              {
                'id': 'beta',
                'binding_id': 'beta',
                'name': 'Shared session',
                'requestCount': 1,
                'latestAt': now + 10000,
                'preview': 'Other latest preview',
                'needsReview': 0,
                'waiting': 0,
                'answered': 1,
                'closed': 0,
              },
          ],
          'attention': [
            {
              'id': 'delivery:failed',
              'bindingId': 'alpha',
              'requestId': 'tg:new',
              'title': 'Reply delivery needs attention',
              'text': 'Messaging service did not confirm delivery.',
              'at': now + 6000,
            },
          ],
        };
      }
      if (id == 'beta' && holdBeta) return betaPending.future;
      final older = uri.queryParameters.containsKey('beforeAt');
      if (older) olderCalls++;
      return thread(id, older: older);
    }
    if (path.startsWith('/api/request-events')) {
      return {'events': [], 'deliveries': []};
    }
    final data = await super.get(path);
    data['bindings'] = [
      {
        'id': 'alpha',
        'alias': 'alpha',
        'name': 'Shared session',
        'provider': 'claude',
        'executionMode': 'desktop',
        'native_id': 'alpha-native-id',
        'cwd': '/sample/alpha',
        'enabled': 1,
      },
      {
        'id': 'beta',
        'alias': 'beta',
        'name': 'Shared session',
        'provider': 'codex',
        'executionMode': 'cli',
        'native_id': 'beta-native-id',
        'cwd': '/sample/beta',
        'enabled': 1,
      },
    ];
    data['pendingJobs'] = testJobs
        .where((j) => j['status'] == 'uncertain')
        .toList();
    data['jobs'] = testJobs;
    data['commandTurns'] = [
      {
        'id': 'cmd:one',
        'label': '/claude',
        'status': 'handled',
        'summary': '💬 *Reply*\nReady for your next message.\n\n— FarFromDesk',
        'created_at': now,
      },
    ];
    data['approvals'] = [];
    data['voiceRequests'] = [];
    data['unlinkedUpdates'] = [];
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/request-review') {
      reviewed.add(Map.of(data));
      oldReviewed = true;
      return {};
    }
    return super.post(path, data);
  }
}

class SameTimestampInboxGateway extends SessionInboxGateway {
  bool newPage = false;
  @override
  Map<String, dynamic> thread(String id, {bool older = false}) {
    if (id != 'alpha') {
      return super.thread(id, older: older);
    }
    Map<String, dynamic> message(int n, String text) => {
      'key': '1:reply:${n.toString().padLeft(3, '0')}',
      'requestId': 'tg:new',
      'kind': 'progress',
      'text': text,
      'at': SessionInboxGateway.now,
      'destination': 'tg:owner',
      'voice': 0,
    };
    return {
      'messages': older
          ? [message(100, 'Recovered middle message')]
          : newPage
          ? [for (var n = 200; n < 300; n++) message(n, 'New message $n')]
          : [message(0, 'Original cached message')],
      'jobs': testJobs.where((j) => j['binding_id'] == 'alpha').toList(),
      'next': newPage && !older
          ? {'at': SessionInboxGateway.now, 'id': '1:reply:200'}
          : null,
    };
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

void main() {
  void configure(WidgetTester tester) {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
  }

  /// Settings is tabbed, so a test must select the section it asserts on.
  Future<void> openSettingsTab(WidgetTester tester, String id) async {
    await tester.tap(find.byKey(Key('settings-tab-$id')));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'Messaging options keep Telegram first and preserve disconnect confirmation',
    (tester) async {
      configure(tester);
      final api = PreviewGateway(
        fixture: 'telegram-connected',
        screen: 'overview',
      );
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      final telegram = find.byKey(const ValueKey('messaging-option-telegram'));
      final whatsapp = find.byKey(const ValueKey('messaging-option-whatsapp'));
      expect(telegram, findsOneWidget);
      expect(whatsapp, findsOneWidget);
      expect(tester.getSize(telegram).height, tester.getSize(whatsapp).height);
      expect(
        tester.getTopLeft(telegram).dx,
        lessThan(tester.getTopLeft(whatsapp).dx),
      );
      expect(
        find.descendant(of: telegram, matching: find.text('@ffd_sample_bot')),
        findsOneWidget,
      );
      await tester.ensureVisible(telegram);
      await tester.tap(
        find.descendant(of: telegram, matching: find.text('Disconnect')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Disconnect Telegram?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.telegramState, 'connected');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('WhatsApp reply settings open in a dialog on Overview', (
    tester,
  ) async {
    configure(tester);
    await tester.pumpWidget(
      FarFromDeskApp(
        gateway: PreviewGateway(fixture: 'connected', screen: 'overview'),
      ),
    );
    await tester.pumpAndSettle();
    final option = find.byKey(const ValueKey('messaging-option-whatsapp'));
    expect(
      find.descendant(of: option, matching: find.text('+15551234567')),
      findsOneWidget,
    );
    final destination = find.byKey(
      const ValueKey('whatsapp-destination-settings'),
    );
    await tester.ensureVisible(destination);
    await tester.tap(destination);
    await tester.pumpAndSettle();
    expect(find.text('Where should replies appear?'), findsOneWidget);
    expect(find.text('Private group'), findsOneWidget);
    await tester.tap(find.text('Private group'));
    await tester.pumpAndSettle();
    expect(
      find.text('Your groups where only you are a member'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Messaging setup can be resumed after skipping onboarding', (
    tester,
  ) async {
    configure(tester);
    await tester.pumpWidget(
      FarFromDeskApp(gateway: PreviewGateway(fixture: 'onboarding')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Skip for now'));
    await tester.pumpAndSettle();
    final connect = find.descendant(
      of: find.byKey(const ValueKey('messaging-option-whatsapp')),
      matching: find.text('Connect'),
    );
    await tester.ensureVisible(connect);
    await tester.tap(connect);
    await tester.pumpAndSettle();
    expect(find.text('Connect your WhatsApp'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'Remote settings keep both active stop actions and remove local setup',
    (tester) async {
      configure(tester);
      final api = _RemoteGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      await openSettingsTab(tester, 'remote');
      final password = find.byKey(const Key('remote-password'));
      await tester.ensureVisible(password);
      expect(find.text('Setup remote control'), findsOneWidget);
      // The stepper and the group heading deliberately share this word.
      expect(find.text('Permissions'), findsWidgets);
      expect(find.text('Accessibility'), findsOneWidget);
      expect(find.byKey(const Key('mac-control-enabled')), findsNothing);
      expect(find.byKey(const Key('remote-desktop-settings')), findsNothing);
      expect(find.text('Connect from your phone'), findsOneWidget);
      expect(find.text('Same Wi-Fi preview'), findsNothing);
      final wifiStop = find.byKey(const Key('wifi-stop'));
      await tester.ensureVisible(wifiStop);
      await tester.tap(wifiStop);
      await tester.pumpAndSettle();
      expect(api.actions, contains('stop'));
      expect(find.byKey(const Key('wifi-stop')), findsNothing);
      final linkStop = find.byKey(const Key('remote-link-stop'));
      await tester.ensureVisible(linkStop);
      await tester.tap(linkStop);
      await tester.pumpAndSettle();
      expect(api.actions, contains('link-stop'));
      expect(find.text('Access & availability'), findsNothing);
      expect(find.text('Coding platforms'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('A saved bot that is offline opens the app, not the setup wizard', (
    tester,
  ) async {
    configure(tester);
    await tester.pumpWidget(
      FarFromDeskApp(gateway: PreviewGateway(fixture: 'telegram-offline')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Connect your Telegram bot'), findsNothing);
    expect(find.text('Step 2 of 4'), findsNothing);
    expect(find.byKey(const Key('channel-offline')), findsOneWidget);
    expect(find.text('Retry now'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('An unconfigured channel still opens setup', (tester) async {
    configure(tester);
    await tester.pumpWidget(
      FarFromDeskApp(gateway: PreviewGateway(fixture: 'telegram')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Connect your\nTelegram bot'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Settings shows one section at a time and switches on the nav', (
    tester,
  ) async {
    configure(tester);
    await tester.pumpWidget(
      FarFromDeskApp(
        gateway: PreviewGateway(fixture: 'connected', screen: 'settings'),
      ),
    );
    await tester.pumpAndSettle();
    // This Mac is the landing tab, and nothing else is in the tree with it.
    expect(find.text('Run in the background'), findsOneWidget);
    expect(find.text('Open at login'), findsOneWidget);
    expect(find.text('Update schedule'), findsNothing);
    expect(find.text('Setup remote control'), findsNothing);
    await openSettingsTab(tester, 'updates');
    expect(find.text('Update schedule'), findsOneWidget);
    expect(find.text('Run in the background'), findsNothing);
    await openSettingsTab(tester, 'this-mac');
    expect(find.text('Run in the background'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Updates never claims the app is current before a check', (
    tester,
  ) async {
    configure(tester);
    await tester.pumpWidget(
      FarFromDeskApp(
        gateway: PreviewGateway(fixture: 'connected', screen: 'settings'),
      ),
    );
    await tester.pumpAndSettle();
    await openSettingsTab(tester, 'updates');
    // An unchecked feed is not evidence of being up to date.
    expect(find.text('Not checked yet on this run'), findsOneWidget);
    expect(find.text('You are up to date'), findsNothing);
    expect(find.text('App updates'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Remote control leads with the three setup steps', (tester) async {
    configure(tester);
    await tester.pumpWidget(FarFromDeskApp(gateway: _RemoteGateway()));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    await openSettingsTab(tester, 'remote');
    expect(find.text('Setup remote control'), findsOneWidget);
    // The stepper names each step even when nothing is set yet, so the page
    // answers "what is left to do" before it shows the controls.
    for (final step in ['Permissions', 'Password', 'Connect']) {
      expect(find.text(step), findsWidgets);
    }
    expect(find.text('Connect from your phone'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the settings nav stays put while the pane scrolls', (tester) async {
    configure(tester);
    // A short window, so the pane genuinely has something to scroll.
    tester.view.physicalSize = const Size(1160, 560);
    await tester.pumpWidget(
      FarFromDeskApp(
        gateway: PreviewGateway(fixture: 'connected', screen: 'settings'),
      ),
    );
    await tester.pumpAndSettle();
    final tab = find.byKey(const Key('settings-tab-this-mac'));
    final navBefore = tester.getTopLeft(tab);
    final card = find.text('Run in the background');
    final cardBefore = tester.getTopLeft(card);
    // The pane's scroll view is the second one; the first belongs to the nav.
    await tester.drag(
      find.byType(SingleChildScrollView).last,
      const Offset(0, -200),
    );
    await tester.pumpAndSettle();
    // The pane moved, the nav did not.
    expect(tester.getTopLeft(card).dy, lessThan(cardBefore.dy));
    expect(tester.getTopLeft(tab), navBefore);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Settings marks the section that needs attention', (tester) async {
    configure(tester);
    await tester.pumpWidget(FarFromDeskApp(gateway: _AttentionGateway()));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('settings-badge-this-mac')), findsOneWidget);
    expect(find.byKey(const Key('settings-badge-updates')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Settings marks nothing when the bridge is healthy', (
    tester,
  ) async {
    configure(tester);
    await tester.pumpWidget(
      FarFromDeskApp(
        gateway: PreviewGateway(fixture: 'connected', screen: 'settings'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('settings-badge-this-mac')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}

/// A healthy bridge with one failing preference write, which is exactly the
/// state the This Mac tab badge exists to surface.
class _AttentionGateway extends PreviewGateway {
  _AttentionGateway() : super(fixture: 'connected', screen: 'settings');
  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    if (path == '/api/status') {
      final prefs = Map<String, dynamic>.from(data['preferences'] ?? {});
      prefs['error'] = 'Could not change sleep settings.';
      data['preferences'] = prefs;
    }
    return data;
  }
}

class _RemoteGateway extends PreviewGateway {
  _RemoteGateway() : super(fixture: 'connected', screen: 'settings');
  bool running = true;
  String link = 'offered';
  final actions = <String>[];
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/remote-control') return {'state': link};
    if (path == '/api/phone-remote') {
      return {
        'supported': true,
        'passwordSet': false,
        'running': running,
        'addresses': [],
      };
    }
    final data = await super.get(path);
    if (path == '/api/status') {
      data['macControl'] = {'supported': true, 'enabled': false};
    }
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/phone-remote' && data['action'] == 'stop') {
      actions.add('stop');
      running = false;
      return {};
    }
    if (path == '/api/remote-control') {
      actions.add('link-stop');
      link = 'ended';
      return {};
    }
    return super.post(path, data);
  }
}

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
      final password = find.byKey(const Key('remote-password'));
      await tester.ensureVisible(password);
      expect(find.text('Control from anywhere'), findsOneWidget);
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

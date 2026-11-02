import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/social_screen.dart';
import 'package:farfromdesk/social_image_settings.dart';

import 'social_live_workspace_test.dart' show FakeLocalSocial;

class ImageSettingsGateway extends FakeLocalSocial {
  String provider = 'local';
  bool configured = false;
  Map<String, dynamic>? saved;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/social/settings')
      return {'imageProvider': provider, 'metaConfigured': configured};
    final data = await super.get(path);
    if (path == '/api/status') data['metaBrain'] = {'configured': configured};
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/social/settings') {
      saved = Map.of(data);
      provider = data['imageProvider'];
      configured = configured || data['key'] != null;
      return {'imageProvider': provider, 'metaConfigured': configured};
    }
    return super.post(path, data);
  }
}

void main() {
  testWidgets(
    'Social shows default source, configures Meta and passes it to Generate',
    (tester) async {
      tester.view.physicalSize = const Size(1400, 1100);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = ImageSettingsGateway();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: SocialScreen(gateway: api)),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Local SVG skill'), findsOneWidget);
      await tester.tap(find.byKey(const Key('social-change-image-provider')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('social-default-image-provider')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Meta API').last);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const Key('social-save-image-settings')),
            )
            .onPressed,
        isNull,
      );
      final field = find.byKey(const Key('social-meta-key'));
      expect(tester.widget<TextField>(field).obscureText, isTrue);
      await tester.enterText(field, 'synthetic-only-key-for-widget-test');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('social-save-image-settings')));
      await tester.pumpAndSettle();
      expect(api.saved?['imageProvider'], 'meta');
      expect(find.text('Key saved'), findsOneWidget);
      expect(find.textContaining('synthetic-only-key'), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Generate'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<DropdownButtonFormField<String>>(
              find.byKey(const Key('social-image-provider')),
            )
            .initialValue,
        'meta',
      );
      await tester.tap(find.byKey(const Key('social-session-selector')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.text('Example session · Codex · native-exact').last,
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField).first,
        'Create a post about carts',
      );
      await tester.tap(find.text('Instagram'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Send to session'));
      await tester.pumpAndSettle();
      expect(api.dispatch?['imageProvider'], 'meta');
      expect(api.dispatch!.containsKey('key'), isFalse);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'switching to Local keeps the saved key and does not send it again',
    (tester) async {
      final api = ImageSettingsGateway()
        ..provider = 'meta'
        ..configured = true;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: SocialImageSettings(gateway: api)),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('social-meta-key')))
            .controller!
            .text,
        isEmpty,
      );
      await tester.tap(find.byKey(const Key('social-default-image-provider')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Local SVG skill').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('social-save-image-settings')));
      await tester.pumpAndSettle();
      expect(api.saved, {'imageProvider': 'local'});
      expect(api.configured, isTrue);
    },
  );
}

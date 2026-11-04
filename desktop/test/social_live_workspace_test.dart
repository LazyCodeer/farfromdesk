import 'package:farfromdesk/preview.dart';
import 'package:farfromdesk/social_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeLocalSocial extends PreviewGateway {
  FakeLocalSocial() : super(fixture: 'connected');
  @override
  bool get preview => false;
  Map<String, dynamic>? dispatch;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/status') {
      return {
        'channelChosen': true,
        'controlChannel': 'telegram',
        'telegram': {'status': 'connected', 'ownerId': '42'},
        'bindings': [
          {
            'id': 'exact',
            'name': 'Example session',
            'provider': 'codex',
            'native_id': 'native-exact',
            'enabled': 1,
          },
        ],
      };
    }
    if (path.startsWith('/api/social?id=')) {
      return {
        'draft': {
          'id': 'd1',
          'revision': 1,
          'brief': 'Synthetic brief',
          'caption': 'Synthetic saved caption',
          'imagePrompt': '',
        },
      };
    }
    if (path == '/api/social') {
      return {
        'drafts': [
          {'id': 'd1', 'brief': 'Synthetic brief'},
        ],
      };
    }
    return super.get(path);
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/social/dispatch') {
      dispatch = Map<String, dynamic>.from(data);
      return {'requestId': 'req-1', 'status': 'queued'};
    }
    return super.post(path, data);
  }
}

void main() {
  testWidgets('local screen loads and reviews a saved draft', (tester) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: SocialScreen(gateway: FakeLocalSocial())),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-tab-drafts')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-draft-card-d1')));
    await tester.pumpAndSettle();
    expect(find.text('Synthetic saved caption'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Generate'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('local Generate reaches the explicitly selected session', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = FakeLocalSocial();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: SocialScreen(gateway: api)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Generate'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-session-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Example session · Codex · native-exact').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'Explain a feature');
    await tester.tap(find.text('LinkedIn'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send to session'));
    await tester.pumpAndSettle();
    expect(api.dispatch?['bindingId'], 'exact');
    expect(api.dispatch?['platforms'], ['linkedin']);
    expect(find.textContaining('Request queued.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

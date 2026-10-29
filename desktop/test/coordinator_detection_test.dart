import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

class DetectionGateway extends PreviewGateway {
  DetectionGateway({this.found = true}) : super(fixture: 'connected');
  bool found;
  int checks = 0;
  @override
  String get platform => 'windows';
  @override
  bool get preview => false;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/master-options?fresh=1') {
      checks++;
      found = true;
      return {};
    }
    final result = await super.get(path);
    if (path == '/api/status') {
      result['master'] = null;
      result['coordinators'] = [];
      result['masterSetup']['platforms'] = [
        for (final provider in ['codex', 'claude'])
          for (final mode in ['cli', 'desktop'])
            {
              'provider': provider,
              'executionMode': mode,
              'available': found && provider == 'claude' && mode == 'cli',
              'canCreate': checks > 0 && provider == 'claude' && mode == 'cli',
              'sessions': [],
              'connection': {
                'state': checks > 0 ? 'configured' : 'unknown',
                'label': checks > 0
                    ? 'Claude API / token configured · model access not tested'
                    : 'CLI account check unavailable · click Check apps to retry',
                'revision': 'test-$checks',
              },
            },
      ];
    }
    return result;
  }
}

void main() {
  void viewport(WidgetTester tester, Size size) {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }

  testWidgets(
    'Overview shows only detected apps and retries native authentication in its setup card',
    (tester) async {
      viewport(tester, const Size(1572, 954));
      final api = DetectionGateway();
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('coordinator-platform-claude:cli')),
        findsOneWidget,
      );
      for (final id in ['codex:cli', 'codex:desktop', 'claude:desktop']) {
        expect(find.byKey(ValueKey('coordinator-platform-$id')), findsNothing);
      }
      expect(find.text('Check unavailable'), findsOneWidget);
      expect(find.text('Sign in first'), findsNothing);
      await tester.ensureVisible(find.text('Check apps'));
      await tester.tap(find.text('Check apps'));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(api.checks, 1);
      expect(find.text('API / token configured'), findsOneWidget);
      final create = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Create Claude CLI coordinator'),
      );
      expect(create.onPressed, isNotNull);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'No detected apps retains a visible retry and recovers when an app is found',
    (tester) async {
      viewport(tester, const Size(1100, 760));
      final api = DetectionGateway(found: false);
      await tester.pumpWidget(FarFromDeskApp(gateway: api));
      await tester.pumpAndSettle();
      expect(find.textContaining('No coding apps detected.'), findsOneWidget);
      expect(find.text('Create Codex CLI coordinator'), findsNothing);
      await tester.ensureVisible(find.text('Check apps'));
      await tester.tap(find.text('Check apps'));
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('coordinator-platform-claude:cli')),
        findsOneWidget,
      );
      expect(find.text('API / token configured'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Coordinator form and actions remain inside their Overview card at wide and scaled sizes',
    (tester) async {
      viewport(tester, const Size(1572, 954));
      for (final width in [1572.0, 1100.0]) {
        tester.view.physicalSize = Size(width, 954);
        tester.platformDispatcher.textScaleFactorTestValue = width == 1100
            ? 1.3
            : 1;
        await tester.pumpWidget(
          FarFromDeskApp(gateway: DetectionGateway()..checks = 1),
        );
        await tester.pumpAndSettle();
        final card = tester.getRect(
          find.byKey(const ValueKey('overview-coordinator-card')),
        );
        final action = tester.getRect(
          find.text('Create Claude CLI coordinator'),
        );
        final voice = tester.getRect(find.text('Voice notes ready'));
        expect(action.bottom, lessThanOrEqualTo(card.bottom));
        expect(action.right, lessThanOrEqualTo(card.right));
        expect(voice.top, greaterThan(card.bottom));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      }
    },
  );
}

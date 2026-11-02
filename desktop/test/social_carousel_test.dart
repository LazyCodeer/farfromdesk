import 'package:farfromdesk/social_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'social_screen_test.dart' show FakeSocialGateway, syntheticJpeg;

void main() {
  testWidgets(
    'ordered carousel slides can be browsed and exported without an image provider',
    (tester) async {
      tester.view.physicalSize = const Size(1400, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = FakeSocialGateway();
      api.record!['carousel'] = {
        'slides': [
          {'base64': syntheticJpeg},
          {'base64': syntheticJpeg},
        ],
      };
      api.record!['format'] = 'Carousel';
      final key = GlobalKey<SocialScreenState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SocialScreen(key: key, gateway: api),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('social-tab-drafts')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('social-draft-card-sample')));
      await tester.pumpAndSettle();
      expect(find.text('1 / 2'), findsOneWidget);
      final media = tester.getRect(
        find.byKey(const Key('social-media-sample')),
      );
      for (final tooltip in ['Previous slide', 'Next slide']) {
        expect(
          media.contains(tester.getCenter(find.byTooltip(tooltip))),
          isTrue,
        );
      }
      expect(media.contains(tester.getCenter(find.text('1 / 2'))), isTrue);
      for (final tooltip in [
        'Copy caption',
        'Export slide 1',
        'Delete draft',
      ]) {
        expect(
          tester.getBottomRight(find.byTooltip(tooltip)).dy,
          lessThan(media.top),
        );
      }
      expect(
        tester
            .widget<IconButton>(
              find.byWidgetPredicate(
                (w) => w is IconButton && w.tooltip == 'Previous slide',
              ),
            )
            .onPressed,
        isNull,
      );

      await tester.tap(find.byTooltip('Next slide'));
      await tester.pumpAndSettle();
      expect(find.text('2 / 2'), findsOneWidget);
      expect(key.currentState!.selectedSlide, 1);
      expect(
        tester
            .widget<IconButton>(
              find.byWidgetPredicate(
                (w) => w is IconButton && w.tooltip == 'Next slide',
              ),
            )
            .onPressed,
        isNull,
      );
      api.record!['revision'] = 2;
      api.record!['caption'] = 'Updated caption from the session';
      await key.currentState!.refreshQuietly();
      await tester.pumpAndSettle();
      expect(key.currentState!.selectedSlide, 1);
      expect(find.text('2 / 2'), findsOneWidget);
      expect(find.text('Updated caption from the session'), findsOneWidget);
      await tester.ensureVisible(find.byTooltip('Export slide 2'));
      await tester.tap(find.byTooltip('Export slide 2'));
      await tester.pumpAndSettle();
      expect(api.savedImageLength, isNotNull);
      expect(api.providerPreparations, 0);
      expect(tester.takeException(), isNull);
    },
  );
}

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/social_workspace.dart';
import 'package:farfromdesk/bridge_theme.dart';
import 'package:farfromdesk/social_generate_dialog.dart';

import 'social_live_workspace_test.dart' show FakeLocalSocial;

void main() {
  testWidgets('render all Social states for review and check layout', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1120, 1060);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    for (final entry in {
      'Onest': 'assets/Onest-Regular.ttf',
      'MaterialIcons': 'fonts/MaterialIcons-Regular.otf',
    }.entries) {
      final loader = FontLoader(entry.key)
        ..addFont(rootBundle.load(entry.value));
      await loader.load();
    }
    final output = Directory(
      '/Volumes/Personal/Developer/FarFromDesk/Builds/social-complete-cards-20261031/screens',
    );
    await tester.runAsync(() => output.create(recursive: true));
    final boundary = GlobalKey();
    final raw = await rootBundle.load('assets/social/template-0.jpg');
    final bytes = Uint8List.sublistView(raw);
    final today = DateTime.now().toUtc().toIso8601String();
    final draft = <String, dynamic>{
      'id': 'visual-1',
      'brief': 'A better way to stay close to your work',
      'platform': 'Instagram',
      'format': 'Carousel',
      'caption': 'Send a clear request from your phone. Review the work when it is ready.',
      'createdAt': today,
    };
    Future<void> mount(bool populated) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: bridgeTheme().copyWith(
            textTheme: bridgeTheme().textTheme.apply(fontFamily: 'Onest'),
            filledButtonTheme: FilledButtonThemeData(
              style: bridgeTheme().filledButtonTheme.style?.copyWith(
                textStyle: const WidgetStatePropertyAll(
                  TextStyle(fontFamily: 'Onest'),
                ),
              ),
            ),
            outlinedButtonTheme: OutlinedButtonThemeData(
              style: bridgeTheme().outlinedButtonTheme.style?.copyWith(
                textStyle: const WidgetStatePropertyAll(
                  TextStyle(fontFamily: 'Onest'),
                ),
              ),
            ),
            textButtonTheme: TextButtonThemeData(
              style: bridgeTheme().textButtonTheme.style?.copyWith(
                textStyle: const WidgetStatePropertyAll(
                  TextStyle(fontFamily: 'Onest'),
                ),
              ),
            ),
          ),
          home: RepaintBoundary(
            key: boundary,
            child: Scaffold(
              body: SocialWorkspace(
                key: ValueKey(populated),
                drafts: populated
                    ? [
                        draft,
                        {
                          ...draft,
                          'id': 'visual-2',
                          'platform': 'LinkedIn',
                          'brief':
                              'Helpful conversations recover more than carts',
                          'caption': 'Draft caption for review.',
                        },
                      ]
                    : [],
                imageProvider: 'local',
                metaConfigured: true,
                onChangeImageProvider: () {},
                selectedDraft: populated ? draft : null,
                imageBytes: populated ? bytes : null,
                slideCount: populated ? 2 : 0,
                slideImages: populated ? [bytes, bytes] : [],
                onSelectSlide: (_) {},
                onGenerate: (_) async {},
                onDraftAction: (_, _) async {},
                onCopy: () {},
                onExportImage: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    Future<void> capture(String name) async {
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 150));
      });
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final box =
          boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      await tester.runAsync(() async {
        final image = await box.toImage(pixelRatio: 1);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('${output.path}/$name.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
    }

    await mount(false);
    await capture('calendar-empty');
    for (final tab in ['ideas', 'brand', 'templates']) {
      await tester.tap(find.byKey(Key('social-tab-$tab')));
      await tester.pumpAndSettle();
      await capture(tab);
    }
    await mount(true);
    await capture('calendar');
    await tester.tap(find.byKey(const Key('social-tab-drafts')));
    await tester.pumpAndSettle();
    await capture('drafts');
    final reviewTheme = Theme.of(boundary.currentContext!);
    await tester.pumpWidget(
      MaterialApp(
        key: const ValueKey('generate-dialog-review'),
        theme: reviewTheme,
        home: RepaintBoundary(
          key: boundary,
          child: Scaffold(
            body: SocialGenerateDialog(gateway: FakeLocalSocial()),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await capture('generate-dialog');
  });
}

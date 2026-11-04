import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/social_workspace.dart';

void main() {
  Future<void> pumpWorkspace(
    WidgetTester tester,
    SocialWorkspace workspace,
  ) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: workspace)));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'all cards show their full captions and use equal media heights',
    (tester) async {
      await pumpWorkspace(
        tester,
        SocialWorkspace(
          drafts: [
            {
              'id': 'a',
              'platform': 'Instagram',
              'brief': 'First',
              'caption': 'First complete caption',
            },
            {
              'id': 'b',
              'platform': 'LinkedIn',
              'brief': 'Second',
              'caption': 'Second complete caption',
            },
          ],
        ),
      );
      await tester.tap(find.byKey(const Key('social-tab-drafts')));
      await tester.pumpAndSettle();
      expect(find.text('First complete caption'), findsOneWidget);
      expect(find.text('Second complete caption'), findsOneWidget);
      expect(
        tester.getSize(find.byKey(const Key('social-media-a'))).height,
        256,
      );
      expect(
        tester.getSize(find.byKey(const Key('social-media-b'))).height,
        256,
      );
      expect(
        tester.widget<Text>(find.text('First complete caption')).maxLines,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('draft cards select from artwork, caption and padding', (
    tester,
  ) async {
    final selections = <String>[];
    await pumpWorkspace(
      tester,
      SocialWorkspace(
        drafts: const [
          {
            'id': 'other',
            'brief': 'Other draft',
            'caption': 'Click this caption to select its draft',
            'format': 'Single image post',
            'thumbnail': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          },
        ],
        onSelectDraft: selections.add,
      ),
    );
    await tester.tap(find.byKey(const Key('social-tab-drafts')));
    await tester.pumpAndSettle();
    for (final target in [
      find.byKey(const Key('social-media-other')),
      find.text('Click this caption to select its draft'),
    ]) {
      selections.clear();
      await tester.ensureVisible(target);
      await tester.tap(target);
      await tester.pump();
      expect(selections, [
        'other',
      ], reason: 'The tapped card content must select its draft: $target');
    }
    selections.clear();
    final card = find.byKey(const Key('social-draft-card-other'));
    await tester.ensureVisible(card);
    await tester.tapAt(tester.getTopLeft(card) + const Offset(3, 3));
    expect(selections, ['other']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('platform icons expand on hover and focus, then filter drafts', (
    tester,
  ) async {
    await pumpWorkspace(
      tester,
      SocialWorkspace(
        drafts: [
          {
            'id': 'a',
            'platform': 'Instagram',
            'brief': 'Instagram draft',
            'createdAt': DateTime.now().toIso8601String(),
          },
          {
            'id': 'b',
            'platform': 'LinkedIn',
            'brief': 'LinkedIn draft',
            'createdAt': DateTime.now().toIso8601String(),
          },
        ],
      ),
    );
    expect(find.text('Drafts created on this day'), findsNothing);
    expect(find.text('2 drafts'), findsNothing);
    final chip = find.byKey(const Key('calendar-filter-Instagram'));
    final compactWidth = tester.getSize(chip).width;
    expect(find.text('Instagram (1)'), findsNothing);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(chip));
    await tester.pumpAndSettle();
    expect(find.text('Instagram (1)'), findsOneWidget);
    expect(tester.getSize(chip).width, greaterThan(compactWidth));
    await mouse.moveTo(Offset.zero);
    await tester.pumpAndSettle();
    expect(find.text('Instagram (1)'), findsNothing);
    final animated = find.descendant(
      of: chip,
      matching: find.byType(AnimatedSize),
    );
    Focus.of(tester.element(animated)).requestFocus();
    await tester.pumpAndSettle();
    expect(find.text('Instagram (1)'), findsOneWidget);
    await tester.tap(chip);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('social-draft-card-a')), findsOneWidget);
    expect(find.byKey(const Key('social-draft-card-b')), findsNothing);
    await mouse.removePointer();
    expect(tester.takeException(), isNull);
  });

  testWidgets('search sits beside tabs and survives tab changes and resizing', (
    tester,
  ) async {
    await pumpWorkspace(
      tester,
      const SocialWorkspace(
        drafts: [
          {'id': 'a', 'brief': 'Alpha draft'},
          {'id': 'b', 'brief': 'Beta draft'},
        ],
      ),
    );
    final draftsTab = find.byKey(const Key('social-tab-drafts'));
    await tester.tap(draftsTab);
    await tester.pumpAndSettle();
    final search = find.byKey(const ValueKey('Search drafts'));
    final tabsEnd = tester.getRect(
      find.byKey(const Key('social-tab-templates')),
    );
    final field = tester.getRect(search);
    expect(field.left, greaterThan(tabsEnd.right));
    expect(field.top, lessThan(tabsEnd.bottom));
    expect(field.bottom, greaterThan(tabsEnd.top));
    await tester.enterText(search, 'Alpha');
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('social-draft-card-a')), findsOneWidget);
    expect(find.byKey(const Key('social-draft-card-b')), findsNothing);
    await tester.tap(find.byKey(const Key('social-tab-templates')));
    await tester.pumpAndSettle();
    await tester.tap(draftsTab);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(search).controller!.text, 'Alpha');
    tester.view.physicalSize = const Size(600, 1000);
    await tester.pumpAndSettle();
    expect(
      tester.getRect(search).top,
      greaterThan(tester.getRect(draftsTab).bottom),
    );
    expect(tester.widget<TextField>(search).controller!.text, 'Alpha');
    expect(find.byKey(const Key('social-draft-card-b')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('empty calendar and all five tabs show honest empty states', (
    tester,
  ) async {
    await pumpWorkspace(tester, const SocialWorkspace(drafts: []));
    expect(find.text('No posts yet'), findsOneWidget);
    expect(find.byKey(const Key('social-next-day')), findsOneWidget);
    expect(find.text('Week'), findsNothing);
    expect(
      find.text('Agent-request integration is not connected in this build.'),
      findsOneWidget,
    );
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Generate'))
          .onPressed,
      isNull,
    );
    for (final name in ['drafts', 'ideas', 'brand', 'templates']) {
      await tester.tap(find.byKey(Key('social-tab-$name')));
      await tester.pumpAndSettle();
    }
    expect(find.text('Product launch carousel'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'draft selection and copy use host callbacks, with no invented date',
    (tester) async {
      String? chosen;
      var copied = false;
      await pumpWorkspace(
        tester,
        SocialWorkspace(
          drafts: const [
            {'id': 'd1', 'brief': 'A real saved brief'},
          ],
          selectedDraft: const {
            'id': 'd1',
            'brief': 'A real saved brief',
            'caption': 'Exact saved caption',
          },
          onSelectDraft: (id) => chosen = id,
          onCopy: () => copied = true,
        ),
      );
      expect(find.text('No drafts on this day'), findsOneWidget);
      await tester.tap(find.byKey(const Key('social-tab-drafts')));
      await tester.pumpAndSettle();
      expect(find.text('Exact saved caption'), findsOneWidget);
      expect(
        find.textContaining('This screen cannot resend a saved draft'),
        findsNothing,
      );
      expect(
        find.textContaining('session can still reply in your paired chat'),
        findsNothing,
      );
      await tester.tap(find.byKey(const Key('social-draft-card-d1')));
      expect(chosen, 'd1');
      await tester.ensureVisible(find.byTooltip('Copy caption'));
      await tester.tap(find.byTooltip('Copy caption'));
      expect(copied, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('template starts an agent request with a reusable brief', (
    tester,
  ) async {
    String? prompt;
    await pumpWorkspace(
      tester,
      SocialWorkspace(
        drafts: const [],
        onGenerate: (value) async {
          prompt = value;
        },
      ),
    );
    await tester.tap(find.byKey(const Key('social-tab-templates')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Use template').first);
    await tester.pumpAndSettle();
    expect(prompt, contains('Product launch carousel for Instagram'));
    expect(prompt, contains('Format: Carousel'));
    expect(prompt, contains('ask for missing essential details'));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'calendar uses creation dates and keeps undated drafts in library',
    (tester) async {
      String? chosen;
      final created = DateTime.now().toUtc().toIso8601String();
      await pumpWorkspace(
        tester,
        SocialWorkspace(
          drafts: [
            {
              'id': 'dated',
              'brief': 'Dated draft',
              'platform': 'LinkedIn',
              'format': 'Post',
              'createdAt': created,
            },
            {'id': 'old', 'brief': 'Undated draft'},
          ],
          onSelectDraft: (id) => chosen = id,
        ),
      );
      expect(find.text('1 draft'), findsNothing);
      expect(find.byKey(const Key('social-draft-card-dated')), findsOneWidget);
      expect(
        find.text('Older undated drafts are available in Drafts.'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('social-draft-card-dated')));
      await tester.pumpAndSettle();
      expect(chosen, 'dated');
      expect(find.byKey(const Key('social-draft-card-old')), findsNothing);
      await tester.tap(find.byKey(const Key('social-tab-drafts')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('social-draft-card-old')), findsOneWidget);
      await tester.tap(find.byKey(const Key('draft-filter-LinkedIn')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('social-draft-card-dated')), findsOneWidget);
      expect(find.byKey(const Key('social-draft-card-old')), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('template cards contain their own preview and Generate brief', (
    tester,
  ) async {
    String? prompt;
    await pumpWorkspace(
      tester,
      SocialWorkspace(
        drafts: const [],
        onGenerate: (value) async {
          prompt = value;
        },
      ),
    );
    await tester.tap(find.byKey(const Key('social-tab-templates')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('social-template-preview')), findsNothing);
    expect(
      find.text('Templates start agent requests; they do not publish content.'),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('social-template-card-1')));
    await tester.pumpAndSettle();
    final preview = find.byKey(const Key('social-template-card-1'));
    expect(
      find.descendant(
        of: preview,
        matching: find.text('Thought leadership article'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: preview, matching: find.text('Article')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: preview,
        matching: find.text(
          'A long-form LinkedIn post with insights, industry trends and practical advice.',
        ),
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('social-use-template-1')));
    await tester.pumpAndSettle();
    expect(prompt, contains('Thought leadership article for LinkedIn'));
    expect(prompt, contains('Format: Article'));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'template layout fits a narrow window without enabling unavailable actions',
    (tester) async {
      tester.view.physicalSize = const Size(520, 1100);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(body: SocialWorkspace(drafts: [])),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('social-tab-templates')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('social-tab-templates')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('social-template-preview')), findsNothing);
      expect(
        tester
            .widget<OutlinedButton>(
              find.byKey(const Key('social-use-template-1')),
            )
            .onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('calendar day selection and filters show only real drafts', (
    tester,
  ) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final other = DateTime(
      today.year,
      today.month,
      today.day + (today.weekday == 7 ? -1 : 1),
    );
    await pumpWorkspace(
      tester,
      SocialWorkspace(
        drafts: [
          {
            'id': 'today',
            'brief': 'Today draft',
            'platform': 'Instagram',
            'format': 'Post',
            'createdAt': today.toUtc().toIso8601String(),
          },
          {
            'id': 'other',
            'brief': 'Other day draft',
            'platform': 'LinkedIn',
            'format': 'Post',
            'createdAt': other.toUtc().toIso8601String(),
          },
        ],
      ),
    );
    expect(find.byKey(const Key('social-draft-card-today')), findsOneWidget);
    expect(find.byKey(const Key('social-draft-card-other')), findsNothing);
    expect(find.text('No image preview available'), findsOneWidget);
    expect(find.text('Ready'), findsNothing);
    await tester.tap(
      find.byKey(
        Key(other.isAfter(today) ? 'social-next-day' : 'social-previous-day'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('social-draft-card-today')), findsNothing);
    expect(find.byKey(const Key('social-draft-card-other')), findsOneWidget);
    await tester.tap(find.byKey(const Key('calendar-filter-Instagram')));
    await tester.pumpAndSettle();
    expect(
      find.text('No loaded drafts for this platform on this day.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('saved thumbnail appears without loading the original image', (
    tester,
  ) async {
    await pumpWorkspace(
      tester,
      const SocialWorkspace(
        drafts: [
          {
            'id': 'with-image',
            'brief': 'Real image',
            'platform': 'Instagram',
            'thumbnail': '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z',
          },
          {
            'id': 'bad-image',
            'brief': 'Bad preview',
            'platform': 'X',
            'thumbnail': 'not-base64!',
          },
        ],
      ),
    );
    await tester.tap(find.byKey(const Key('social-tab-drafts')));
    await tester.pumpAndSettle();
    expect(
      find.byWidgetPredicate(
        (w) => w is Image && w.semanticLabel == 'Saved draft image',
      ),
      findsOneWidget,
    );
    expect(find.text('No image preview available'), findsOneWidget);
    final media = find.byWidgetPredicate(
      (w) => w is Image && w.semanticLabel == 'Saved draft image',
    );
    final provider = tester.widget<Image>(media).image;
    tester.element(find.byType(SocialWorkspace)).markNeedsBuild();
    await tester.pumpAndSettle();
    expect(tester.widget<Image>(media).image, provider);
    expect(tester.takeException(), isNull);
  });
  testWidgets('draft cards show placeholders instead of fabricated media', (
    tester,
  ) async {
    await pumpWorkspace(
      tester,
      const SocialWorkspace(
        drafts: [
          {
            'id': 'one',
            'brief': 'A saved text draft',
            'platform': 'LinkedIn',
            'format': 'Post',
          },
          {
            'id': 'two',
            'brief': 'Another text draft',
            'platform': 'X',
            'format': 'Thread',
          },
        ],
      ),
    );
    await tester.tap(find.byKey(const Key('social-tab-drafts')));
    await tester.pumpAndSettle();
    expect(find.text('No image preview available'), findsNWidgets(2));
    expect(
      find.byWidgetPredicate(
        (w) => w is Image && w.semanticLabel == 'Saved draft image',
      ),
      findsNothing,
    );
    expect(find.text('Ready'), findsNothing);
    expect(tester.takeException(), isNull);
  });
  testWidgets('calendar and draft cards fit a narrow window', (tester) async {
    tester.view.physicalSize = const Size(520, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final created = DateTime.now().toUtc().toIso8601String();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SocialWorkspace(
            drafts: [
              {
                'id': 'a',
                'brief': 'Small window draft',
                'platform': 'Instagram',
                'format': 'Carousel',
                'createdAt': created,
              },
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('social-draft-card-a')), findsOneWidget);
    await tester.tap(find.byKey(const Key('social-tab-drafts')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('social-draft-card-a')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('empty calendar examples open the existing Generate flow', (
    tester,
  ) async {
    String? request;
    await pumpWorkspace(
      tester,
      SocialWorkspace(
        drafts: const [],
        onGenerate: (value) async {
          request = value;
        },
      ),
    );
    await tester.tap(find.text('Share product updates'));
    await tester.pumpAndSettle();
    expect(
      request,
      'Create social drafts about our product updates this week.',
    );
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'Ideas and Brand show unconnected states without invented actions or data',
    (tester) async {
      await pumpWorkspace(tester, const SocialWorkspace(drafts: []));
      await tester.tap(find.byKey(const Key('social-tab-ideas')));
      await tester.pumpAndSettle();
      expect(find.text('Your next great post starts here'), findsOneWidget);
      expect(find.text('Idea details'), findsOneWidget);
      expect(find.text('From a topic to a useful story'), findsOneWidget);
      expect(find.text('Sources'), findsOneWidget);
      expect(find.text('Generate drafts for this idea'), findsNothing);
      await tester.tap(find.byKey(const Key('social-tab-brand')));
      await tester.pumpAndSettle();
      for (final label in [
        'Brand overview',
        'Target audience',
        'Brand voice',
        'Key topics',
        'Visual identity',
        'Logo & assets',
        'Example content style',
      ]) {
        expect(find.text(label), findsOneWidget);
      }
      expect(
        find.text('Include this in your generation brief'),
        findsNWidgets(6),
      );
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Define brand'))
            .onPressed,
        isNull,
      );
      expect(
        find.text(
          'Share approved examples in your generation request. A saved brand profile and asset library are not available in this build.',
        ),
        findsOneWidget,
      );
      expect(find.text('Edit'), findsNothing);
      expect(find.text('FarFromDesk'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Ideas and Brand remain usable in a narrow window', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(520, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: SocialWorkspace(drafts: [])),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('social-tab-ideas')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-tab-ideas')));
    await tester.pumpAndSettle();
    expect(find.text('Your next great post starts here'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('social-tab-brand')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-tab-brand')));
    await tester.pumpAndSettle();
    expect(find.text('Your brand, in every post'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'template search and platform filters retain the selected brief',
    (tester) async {
      String? prompt;
      await pumpWorkspace(
        tester,
        SocialWorkspace(drafts: const [], onGenerate: (v) async => prompt = v),
      );
      await tester.tap(find.byKey(const Key('social-tab-templates')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('template-filter-X')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('social-template-card-2')), findsOneWidget);
      expect(find.byKey(const Key('social-template-card-0')), findsNothing);
      await tester.enterText(find.byType(TextField), 'poll');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('social-template-card-2')), findsNothing);
      await tester.tap(find.byKey(const Key('social-template-card-7')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const Key('social-use-template-7')),
      );
      await tester.tap(find.byKey(const Key('social-use-template-7')));
      expect(prompt, contains('Community poll for X. Format: Poll.'));
      expect(tester.takeException(), isNull);
    },
  );
}

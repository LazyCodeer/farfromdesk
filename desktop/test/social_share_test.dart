import 'package:farfromdesk/social_share.dart';
import 'package:farfromdesk/social_share_dialog.dart';
import 'package:farfromdesk/social_screen.dart';

import 'social_screen_test.dart' show FakeSocialGateway, syntheticJpeg;

import 'package:farfromdesk/preview.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class ShareGateway extends PreviewGateway {
  ShareGateway() : super(fixture: 'connected');
  final opens = <String>[];
  SocialSharePayload? exported, shared;
  bool exportResult = true, failOpen = false;
  @override
  bool get canShareSocialNatively => true;
  @override
  Future<void> openSocialPlatform(String platform, String caption) async {
    if (failOpen) throw StateError('failed');
    opens.add('$platform:$caption');
  }

  @override
  Future<bool> exportSocialPost(SocialSharePayload post) async {
    exported = post;
    return exportResult;
  }

  @override
  Future<bool> shareSocialPost(SocialSharePayload post) async {
    shared = post;
    return true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (_) async => null);
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });
  test(
    'intents preserve unicode, newlines and URL-like caption without injection',
    () {
      const caption = 'Hello ✨ &next=bad\nhttps://example.com/?q=a#fragment';
      for (final name in ['X', 'WhatsApp']) {
        final target = socialShareTarget(name, caption);
        expect(target.prefillsText, true);
        expect(target.uri.queryParameters, {'text': caption});
        expect(target.uri.fragment, '');
        expect(target.uri.scheme, 'https');
      }
      for (final name in socialSharePlatforms.where(
        (p) => !['X', 'WhatsApp', 'Other'].contains(p),
      )) {
        final target = socialShareTarget(name, caption);
        expect(target.prefillsText, false);
        expect(target.uri.query, '');
      }
      expect(
        () => socialShareTarget('https://evil.test', caption),
        throwsArgumentError,
      );
    },
  );
  test('long captions fall back to clipboard instead of truncating browser intents', () {
    for (final name in ['X', 'WhatsApp']) {
      final target = socialShareTarget(name, '✨' * 3000);
      expect(target.prefillsText, false);
      expect(target.uri.query, '');
    }
  });
  Future<void> show(
    WidgetTester tester,
    ShareGateway gateway, {
    String platform = 'Instagram',
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SocialShareDialog(
            gateway: gateway,
            initialPlatform: platform,
            post: SocialSharePayload(
              caption: 'Full caption ✨',
              images: [
                Uint8List.fromList([1, 2]),
                Uint8List.fromList([3, 4]),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'export and native share receive every ordered slide; opening is explicit',
    (tester) async {
      final gateway = ShareGateway();
      String? copied;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = call.arguments['text'] as String;
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      await show(tester, gateway);
      expect(gateway.opens, isEmpty);
      await tester.ensureVisible(find.byKey(const Key('social-export-post')));
      await tester.tap(find.byKey(const Key('social-export-post')));
      await tester.pumpAndSettle();
      expect(gateway.exported!.images.map((i) => i.toList()).toList(), [
        [1, 2],
        [3, 4],
      ]);
      expect(gateway.exported!.caption, 'Full caption ✨');
      await tester.ensureVisible(find.byKey(const Key('social-native-share')));
      await tester.tap(find.byKey(const Key('social-native-share')));
      await tester.pumpAndSettle();
      expect(gateway.shared!.images.length, 2);
      expect(find.textContaining('Share sheet opened.'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('social-open-platform')));
      await tester.tap(find.byKey(const Key('social-open-platform')));
      await tester.pumpAndSettle();
      expect(copied, 'Full caption ✨');
      expect(gateway.opens, ['Instagram:Full caption ✨']);
      expect(find.textContaining('no post was sent'), findsOneWidget);
    },
  );
  testWidgets(
    'cancelled export and failed browser action do not report success',
    (tester) async {
      final gateway = ShareGateway()
        ..exportResult = false
        ..failOpen = true;
      await show(tester, gateway);
      await tester.ensureVisible(find.byKey(const Key('social-export-post')));
      await tester.tap(find.byKey(const Key('social-export-post')));
      await tester.pumpAndSettle();
      expect(
        find.text('Export cancelled. No files were saved.'),
        findsOneWidget,
      );
      await tester.ensureVisible(find.byKey(const Key('social-open-platform')));
      await tester.tap(find.byKey(const Key('social-open-platform')));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Could not complete this action'),
        findsOneWidget,
      );
      expect(gateway.opens, isEmpty);
    },
  );
  testWidgets(
    'screen handoff snapshots all slides and caption without provider calls',
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
      await tester.tap(find.byTooltip('Next slide'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('social-share-post')));
      await tester.tap(find.byKey(const Key('social-share-post')));
      await tester.pumpAndSettle();
      final dialog = tester.widget<SocialShareDialog>(
        find.byType(SocialShareDialog),
      );
      expect(dialog.post.images.length, 2);
      expect(dialog.post.caption, 'Saved caption');
      api.record!['caption'] = 'Later session edit';
      await key.currentState!.refreshQuietly();
      await tester.pumpAndSettle();
      expect(dialog.post.caption, 'Saved caption');
      expect(api.posts, isEmpty);
      expect(api.providerPreparations, 0);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('Other provides export/copy without inventing a destination', (
    tester,
  ) async {
    await show(tester, ShareGateway(), platform: 'Other');
    expect(find.byKey(const Key('social-open-platform')), findsNothing);
    expect(find.text('Copy caption'), findsOneWidget);
    expect(find.byKey(const Key('social-export-post')), findsOneWidget);
  });
}

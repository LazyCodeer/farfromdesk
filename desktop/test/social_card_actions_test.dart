import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/social_screen.dart';

import 'social_screen_test.dart' show FakeSocialGateway, syntheticJpeg;

class TwoCardGateway extends FakeSocialGateway {
  bool failSecond = false;
  final second = <String, dynamic>{
    'id': 'second',
    'revision': 7,
    'brief': 'Hidden brief',
    'caption': 'Caption belonging to the second card',
    'platform': 'Instagram',
    'creativeBrief': 'Hidden creative details',
    'format': 'Single image post',
    'image': {'base64': syntheticJpeg},
  };
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/social') {
      return {
        'drafts': [if (record != null) record, second],
      };
    }
    if (path == '/api/social?id=second') {
      if (failSecond) throw StateError('Second card unavailable');
      return {'draft': Map<String, dynamic>.from(second)};
    }
    return super.get(path);
  }
}

void main() {
  String? copied;
  setUp(() {
    copied = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = call.arguments['text'] as String;
          }
          return null;
        });
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null),
  );

  Future<GlobalKey<SocialScreenState>> mount(
    WidgetTester tester,
    TwoCardGateway api,
  ) async {
    tester.view.physicalSize = const Size(1400, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final key = GlobalKey<SocialScreenState>();
    await tester.pumpWidget(
      MaterialApp(
        key: UniqueKey(),
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
    return key;
  }

  for (final action in [
    'copy-caption',
    'export-image',
    'share-post',
    'delete-draft',
  ]) {
    testWidgets('unselected card $action targets its own saved post', (
      tester,
    ) async {
      final api = TwoCardGateway();
      final state = await mount(tester, api);
      for (final name in [
        'copy-caption',
        'export-image',
        'share-post',
        'delete-draft',
      ]) {
        expect(find.byKey(Key('social-$name-second')), findsOneWidget);
      }
      expect(find.text('Hidden brief'), findsNothing);
      expect(find.text('Hidden creative details'), findsNothing);
      expect(find.text('Single image post'), findsNothing);
      expect(find.text('Caption'), findsNothing);
      await tester.tap(find.byKey(Key('social-$action-second')));
      await tester.pumpAndSettle();
      expect(state.currentState!.draft?['id'], 'second');
      if (action == 'copy-caption') expect(copied, api.second['caption']);
      if (action == 'export-image') {
        expect(api.savedImageLength, greaterThan(0));
      }
      if (action == 'share-post') {
        expect(find.byType(AlertDialog), findsOneWidget);
        expect(api.posts, isEmpty);
      }
      if (action == 'delete-draft') {
        expect(api.posts, isEmpty);
        await tester.tap(find.text('Delete draft').last);
        await tester.pumpAndSettle();
        expect(api.posts.single['id'], 'second');
        expect(api.posts.single['revision'], 7);
        expect(api.posts.single['confirmed'], true);
      }
      expect(api.providerPreparations, 0);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'failed loading never applies card actions to the previous draft',
    (tester) async {
      final api = TwoCardGateway()..failSecond = true;
      final state = await mount(tester, api);
      for (final action in [
        'copy-caption',
        'export-image',
        'share-post',
        'delete-draft',
      ]) {
        await tester.tap(find.byKey(Key('social-$action-second')));
        await tester.pumpAndSettle();
        expect(state.currentState!.draft?['id'], 'sample');
        expect(copied, isNull);
        expect(api.savedImageLength, isNull);
        expect(api.posts, isEmpty);
        expect(find.byType(AlertDialog), findsNothing);
      }
      expect(tester.takeException(), isNull);
    },
  );
}

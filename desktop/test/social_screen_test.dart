import 'dart:async';

import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/gateway.dart';
import 'package:farfromdesk/preview.dart';
import 'package:farfromdesk/social_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const syntheticJpeg =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z';

class FakeSocialGateway extends PreviewGateway {
  FakeSocialGateway() : super(fixture: 'connected');
  @override
  bool get preview => false;
  @override
  int get initialScreen => 6;
  Map<String, dynamic>? record = {
    'id': 'sample',
    'revision': 1,
    'brief': 'Synthetic topic',
    'caption': 'Saved caption',
    'imagePrompt': '',
    'platform': 'LinkedIn',
    'format': 'Professional post',
    'createdAt': DateTime.now().toUtc().toIso8601String(),
  };
  final posts = <Map<String, dynamic>>[];
  int providerPreparations = 0;
  int? savedImageLength;
  bool paged = false;
  bool failLoad = false;
  bool noOwner = false;
  Completer<void>? selectGate;

  @override
  Future<SocialGenerator> prepareSocialGenerator() async {
    providerPreparations++;
    throw StateError('Unexpected provider call');
  }

  @override
  Future<bool> saveSocialImage(Uint8List bytes) async {
    savedImageLength = bytes.length;
    return true;
  }

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/status' && noOwner) {
      final value = await super.get(path);
      return {...value, 'channelChosen': false, 'bindings': []};
    }
    if (failLoad && path == '/api/social') {
      throw StateError('Synthetic list failure');
    }
    if (path.startsWith('/api/social?id=old')) {
      return {
        'draft': {
          'id': 'old',
          'revision': 1,
          'brief': 'Older sample',
          'caption': 'Older caption',
          'imagePrompt': '',
        },
      };
    }
    if (path.startsWith('/api/social?id=')) {
      if (selectGate != null) await selectGate!.future;
      return {'draft': Map<String, dynamic>.from(record!)};
    }
    if (path.startsWith('/api/social?before=')) {
      return {
        'drafts': [
          {'id': 'old', 'brief': 'Older sample'},
        ],
        'nextCursor': null,
      };
    }
    if (path == '/api/social') {
      return {
        'drafts': record == null ? [] : [Map<String, dynamic>.from(record!)],
        'nextCursor': paged ? '10' : null,
      };
    }
    return super.get(path);
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    posts.add(Map<String, dynamic>.from(data));
    switch (data['op']) {
      case 'delete':
        record = null;
        return {
          'result': {'deleted': true},
        };
      case 'recover':
        record = {
          ...record!,
          'operation': {
            'status': 'uncertain',
            'operationId': data['operationId'],
          },
        };
        return {'result': Map<String, dynamic>.from(record!)};
      case 'acknowledge':
        record = {...record!, 'operation': null};
        return {'result': Map<String, dynamic>.from(record!)};
      default:
        throw StateError('Unexpected action ${data['op']}');
    }
  }
}

void main() {
  void size(WidgetTester tester) {
    tester.view.physicalSize = const Size(1400, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  Future<void> showDraft(WidgetTester tester, FakeSocialGateway api) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: SocialScreen(gateway: api)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-tab-drafts')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-draft-card-sample')));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'delete requires confirmation and there is no publishing action',
    (tester) async {
      size(tester);
      final api = FakeSocialGateway();
      await showDraft(tester, api);
      expect(find.text('Publish'), findsNothing);
      await tester.tap(find.byTooltip('Delete draft'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel').last);
      await tester.pumpAndSettle();
      expect(api.posts, isEmpty);
      await tester.tap(find.byTooltip('Delete draft'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete draft').last);
      await tester.pumpAndSettle();
      expect(api.posts.single, containsPair('confirmed', true));
      expect(api.posts.single, containsPair('id', 'sample'));
      expect(api.posts.single, containsPair('revision', 1));
      expect(api.record, isNull);
      expect(find.textContaining('No drafts yet'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('missing paired chat prevents dispatch and provider calls', (
    tester,
  ) async {
    size(tester);
    final api = FakeSocialGateway()..noOwner = true;
    await showDraft(tester, api);
    await tester.tap(find.widgetWithText(FilledButton, 'Generate'));
    await tester.pumpAndSettle();
    expect(
      find.text('Connect a paired owner chat before sending.'),
      findsOneWidget,
    );
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Send to session'),
          )
          .onPressed,
      isNull,
    );
    expect(api.posts, isEmpty);
    expect(api.providerPreparations, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'copy preserves the saved caption exactly without a provider call',
    (tester) async {
      size(tester);
      final api = FakeSocialGateway();
      const caption =
          'A carefully reviewed caption ✨\nwith [a link](https://example.com).';
      api.record!['caption'] = caption;
      api.record!['creativeBrief'] = 'Show the product in three calm frames.';
      api.record!['imagePrompt'] = 'Illustration of a quiet desk.';
      String? copied;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      await showDraft(tester, api);
      expect(find.text('Visual brief'), findsNothing);
      expect(find.text('Show the product in three calm frames.'), findsNothing);
      expect(find.text('Image prompt'), findsNothing);
      expect(find.text('Illustration of a quiet desk.'), findsNothing);
      expect(find.text('No image generated'), findsOneWidget);
      await tester.ensureVisible(find.byTooltip('Copy caption'));
      await tester.tap(find.byTooltip('Copy caption'));
      await tester.pumpAndSettle();
      expect(copied, caption);
      expect(api.posts, isEmpty);
      expect(api.providerPreparations, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'interrupted operation recovery is explicit and bound to its operation',
    (tester) async {
      size(tester);
      final api = FakeSocialGateway();
      api.record!['operation'] = {'status': 'running', 'operationId': 'op-123'};
      await showDraft(tester, api);
      await tester.tap(find.text('Recover interrupted request'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('earlier request may still finish'),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel').last);
      await tester.pumpAndSettle();
      expect(api.posts, isEmpty);
      await tester.tap(find.text('Recover interrupted request'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Recover request').last);
      await tester.pumpAndSettle();
      expect(api.posts.single, containsPair('operationId', 'op-123'));
      expect(api.posts.single, containsPair('revision', 1));
      expect(find.text('Acknowledge uncertainty'), findsOneWidget);
      await tester.tap(find.text('Acknowledge uncertainty'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Acknowledge').last);
      await tester.pumpAndSettle();
      expect(api.posts.last, containsPair('operationId', 'op-123'));
      expect(api.providerPreparations, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'older loaded pages remain selectable and undated drafts are not scheduled',
    (tester) async {
      size(tester);
      final api = FakeSocialGateway()..paged = true;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: SocialScreen(gateway: api)),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Showing loaded drafts by creation date'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('social-tab-drafts')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Load older drafts'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('social-draft-card-old')));
      await tester.pumpAndSettle();
      expect(find.text('Older caption'), findsOneWidget);
      await tester.tap(find.byKey(const Key('social-tab-calendar')));
      await tester.pumpAndSettle();
      expect(
        find.text('Older undated drafts are available in Drafts.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('saved image exports only the validated JPEG', (tester) async {
    size(tester);
    final api = FakeSocialGateway();
    api.record!['image'] = {'base64': syntheticJpeg};
    await showDraft(tester, api);
    await tester.tap(find.byTooltip('Export image'));
    await tester.pumpAndSettle();
    expect(api.savedImageLength, greaterThan(4));
    expect(api.providerPreparations, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('invalid image is not exported and list errors remain visible', (
    tester,
  ) async {
    size(tester);
    final api = FakeSocialGateway();
    api.record!['image'] = {'base64': 'not-a-jpeg'};
    await showDraft(tester, api);
    expect(
      find.text('The saved image is invalid or too large to display.'),
      findsOneWidget,
    );
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('social-export-image')))
          .onPressed,
      isNull,
    );
    expect(api.savedImageLength, isNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    final broken = FakeSocialGateway()..failLoad = true;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: SocialScreen(gateway: broken)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Synthetic list failure'), findsOneWidget);
    expect(broken.providerPreparations, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('close guard locks and releases draft actions', (tester) async {
    size(tester);
    final api = FakeSocialGateway(), guard = DesktopCloseGuard();
    await tester.pumpWidget(FarFromDeskApp(gateway: api, closeGuard: guard));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-tab-drafts')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('social-draft-card-sample')));
    await tester.pumpAndSettle();
    expect(await guard.allowClose(), isTrue);
    await tester.pump();
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('social-copy-caption')))
          .onPressed,
      isNull,
    );
    guard.release();
    await tester.pump();
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('social-copy-caption')))
          .onPressed,
      isNotNull,
    );
    expect(api.posts, isEmpty);
    expect(tester.takeException(), isNull);
  }, skip: !const bool.fromEnvironment('FFD_ISOLATED_LOCAL'));
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/meta_brain_panel.dart';
import 'package:farfromdesk/preview.dart';

class MetaGateway extends PreviewGateway {
  Map<String, dynamic>? submitted;
  bool fail = false;
  final posts = <String>[];
  Map<String, dynamic> saved = {};
  Map<String, dynamic> files = {
    'dir': '/tmp/memory',
    'files': [
      {'path': 'MEMORY.md', 'content': '# Memory index\n', 'always': true},
      {
        'path': 'about-me.md',
        'content': '# About you\n- Call me:\n',
        'always': true,
      },
      {
        'path': 'collaboration.md',
        'content': '# Collaboration\nWho handles which work.\n\n- Planning and review: Codex\n',
        'always': true,
      },
      {'path': 'words.md', 'content': '# Words and names\n', 'always': false},
    ],
    'history': [
      {
        'id': 7,
        'at': 0,
        'path': 'words.md',
        'source': 'brain:wa:1',
        'summary': 'Saved "ATC is the air-traffic repo" in words.md',
      },
    ],
    'intro': 'pending',
  };
  String? lastGet;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    lastGet = path;
    if (path == '/api/memory') return files;
    return {
      'tasks': [],
      'workItems': [
        {
          'id': 1,
          'title': 'Invoice export',
          'status': 'in progress',
          'executionState': 'blocked',
          'session': 'invoice-worker',
        },
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    posts.add(path);
    if (path == '/api/memory') saved = data;
    if (path.startsWith('/api/memory')) return files;
    submitted = data;
    if (fail) throw Exception('raw provider error must not be displayed');
    return {'configured': true};
  }
}

void main() {
  for (final savedModel in [null, 'muse-spark-1.2']) {
    testWidgets(
      'model selection ${savedModel ?? 'defaults to Wonder'} is retained',
      (tester) async {
        final api = MetaGateway();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: MetaBrainPanel(
                  gateway: api,
                  saved: {'enabled': true, 'model': savedModel},
                  onSaved: () async {},
                ),
              ),
            ),
          ),
        );
        final dropdown = tester.widget<DropdownButton<String>>(
          find.byType(DropdownButton<String>),
        );
        expect(dropdown.value, savedModel ?? 'muse-wonder-1.0');
        expect(
          dropdown.items!.map((item) => item.value).toList(),
          containsAll([
            'muse-spark-1.3',
            'muse-spark-1.2',
            'muse-spark-1.1',
            'muse-wonder-1.0',
          ]),
        );
        final save = find.text('Save changes');
        await tester.ensureVisible(save);
        await tester.tap(save);
        await tester.pumpAndSettle();
        expect(
          api.submitted?['policy']['model'],
          savedModel ?? 'muse-wonder-1.0',
        );
      },
    );
  }
  for (final fail in [false, true]) {
    testWidgets(
      'Meta settings obscure and clear secret after ${fail ? 'failure' : 'save'}',
      (tester) async {
        final api = MetaGateway()..fail = fail;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: MetaBrainPanel(
                  gateway: api,
                  saved: const {'enabled': true},
                  onSaved: () async {},
                ),
              ),
            ),
          ),
        );
        final input = find.byWidgetPredicate(
          (w) => w is TextField && w.obscureText,
        );
        expect(tester.widget<TextField>(input).obscureText, isTrue);
        expect(tester.widget<TextField>(input).autocorrect, isFalse);
        await tester.enterText(input, 'synthetic-widget-key');
        final save = find.text('Save changes');
        await tester.ensureVisible(save);
        await tester.tap(save);
        await tester.pumpAndSettle();
        expect(api.submitted?['key'], 'synthetic-widget-key');
        expect(tester.widget<TextField>(input).controller!.text, isEmpty);
        expect(find.textContaining('raw provider error'), findsNothing);
        expect(
          find.text(
            fail
                ? 'Could not save. Check the key and background service.'
                : 'Saved. No API call was made.',
          ),
          findsOneWidget,
        );
      },
    );
  }
  testWidgets(
    'turning the brain on lets it route, keep items and answer status',
    (tester) async {
      final api = MetaGateway();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: MetaBrainPanel(
                gateway: api,
                saved: const {'enabled': false},
                onSaved: () async {},
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('brain-enabled')));
      await tester.pumpAndSettle();
      final policy = api.submitted?['policy'];
      expect(policy['enabled'], isTrue);
      expect(policy['allowRouting'], isTrue);
      expect(policy['allowManagement'], isTrue);
      expect(policy['allowStatus'], isTrue);
      expect(policy['failure'], 'legacy');
      expect(find.text('What it may do'), findsNothing);
      expect(find.text('First hello'), findsNothing);
    },
  );
  testWidgets(
    'shared todo board shows assigned session and separate execution state',
    (tester) async {
      final api = MetaGateway();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: MetaBrainPanel(
                gateway: api,
                saved: const {'enabled': true},
                onSaved: () async {},
              ),
            ),
          ),
        ),
      );
      final ledger = find.text('View task history');
      await tester.ensureVisible(ledger);
      await tester.tap(ledger);
      await tester.pumpAndSettle();
      expect(api.lastGet, '/api/meta-brain/tasks?fresh=1');
      expect(find.text('#1 Invoice export'), findsOneWidget);
      expect(find.textContaining('execution: blocked'), findsOneWidget);
      expect(find.textContaining('invoice-worker'), findsOneWidget);
    },
  );
  testWidgets('memory cards add, remove, edit as text and undo', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = MetaGateway();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: MetaBrainPanel(
              gateway: api,
              saved: const {'enabled': false},
              onSaved: () async {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('memory-card-MEMORY.md')), findsNothing);
    expect(find.text('Always read'), findsNWidgets(2));
    expect(find.text('Codex'), findsWidgets);
    await tester.enterText(
      find.byKey(const Key('memory-add-words.md')),
      'Priya reviews design',
    );
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(api.posts.last, '/api/memory');
    expect(api.saved['content'], '# Words and names\n- Priya reviews design\n');
    expect(api.saved['summary'], 'Added "Priya reviews design" to words.md');
    await tester.tap(find.byKey(const Key('memory-remove-collaboration.md-3')));
    await tester.pumpAndSettle();
    expect(api.saved['content'], isNot(contains('Planning and review')));
    await tester.tap(find.byKey(const Key('memory-text-about-me.md')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('memory-editor')),
      '# About you\n- Call me: Sam\n',
    );
    await tester.tap(find.byKey(const Key('memory-save')));
    await tester.pumpAndSettle();
    expect(api.saved['path'], 'about-me.md');
    expect(find.textContaining('from your message'), findsWidgets);
    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    expect(api.posts.last, '/api/memory/undo');
  });
  testWidgets('a new memory file never replaces one that exists', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = MetaGateway();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: MetaBrainPanel(
              gateway: api,
              saved: const {'enabled': false},
              onSaved: () async {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    Future<void> create(String name) async {
      await tester.tap(find.text('New file'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('memory-new-name')), name);
      await tester.tap(find.text('Create'));
      await tester.pumpAndSettle();
    }

    await create('about-me');
    expect(api.posts, isEmpty);
    expect(find.textContaining('about-me.md already exists'), findsOneWidget);
    await create('projects/site');
    expect(api.saved['path'], 'projects/site.md');
    expect(api.saved['expected'], '');
  });
}

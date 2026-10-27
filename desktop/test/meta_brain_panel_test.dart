import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/meta_brain_panel.dart';
import 'package:farfromdesk/preview.dart';

class MetaGateway extends PreviewGateway {
  Map<String, dynamic>? submitted;
  bool fail = false;
  String? lastGet;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    lastGet = path;
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
    submitted = data;
    if (fail) throw Exception('raw provider error must not be displayed');
    return {'configured': true};
  }
}

void main() {
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
        final input = find.byType(TextField);
        expect(tester.widget<TextField>(input).obscureText, isTrue);
        expect(tester.widget<TextField>(input).autocorrect, isFalse);
        await tester.enterText(input, 'synthetic-widget-key');
        final save = find.text('Save');
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
    'management is owner-controlled and fallback defaults to existing routing',
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
      final toggle = find.widgetWithText(
        SwitchListTile,
        'Keep your item list',
      );
      expect(tester.widget<SwitchListTile>(toggle).value, isFalse);
      await tester.ensureVisible(toggle);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      final save = find.text('Save');
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(api.submitted?['policy']['allowManagement'], isTrue);
      expect(api.submitted?['policy']['failure'], 'legacy');
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
}

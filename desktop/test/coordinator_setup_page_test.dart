import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

/// Adds a Muse Code platform and two ranked projects, so the setup page can be exercised the way
/// the backend reports it: workspaces arrive with the ids the create call must send back.
class SetupGateway extends PreviewGateway {
  SetupGateway() : super(fixture: 'connected');

  /// A `provider:mode` key to report as installed-but-unusable, the way a missing app does.
  String? unavailable;
  Map<String, dynamic>? submitted;

  @override
  Future<Map<String, dynamic>> get(String path) async {
    final data = await super.get(path);
    final platforms = data['masterSetup']['platforms'] as List;
    for (final p in platforms) {
      final key = '${p['provider']}:${p['executionMode']}';
      p['available'] = key != unavailable;
      p['canCreate'] = key != unavailable;
      if (key == unavailable) p['reason'] = 'Claude Desktop is not installed';
      p['connection'] = {
        'state': 'verified',
        'label': 'Test CLI account',
        'revision': 'cli-revision',
      };
      if (p['provider'] == 'codex' && p['executionMode'] == 'cli') {
        p['workspaces'] = [
          {
            'id': 'ws-recent',
            'cwd': '/sample/projects/recent',
            'name': 'recent',
            'label': 'recent',
            'available': true,
          },
          {
            'id': 'ws-older',
            'cwd': '/sample/projects/older',
            'name': 'older',
            'label': 'older',
            'available': true,
          },
        ];
      }
    }
    platforms.add({
      'provider': 'muse',
      'executionMode': 'cli',
      'label': 'Muse Code',
      'available': true,
      'canCreate': true,
      'connection': {
        'state': 'verified',
        'label': 'Muse Code CLI · local credential',
        'revision': 'muse-revision',
      },
      'workspaces': [
        {
          'id': 'muse-ws',
          'cwd': '/sample/projects/muse-project',
          'name': 'muse-project',
          'label': 'muse-project',
          'available': true,
        },
      ],
      'sessions': [
        {
          'id': 'muse-session-1',
          'name': 'Saved Muse session',
          'cwd': '/sample/projects/muse-project',
          'model': 'muse-spark-1.3',
          'status': 'Muse session',
          'available': true,
        },
      ],
    });
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> data,
  ) async {
    if (path == '/api/master-create') submitted = data;
    return super.post(path, data);
  }
}

void main() {
  void size(WidgetTester tester) {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    tester.view.physicalSize = const Size(1160, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  Future<SetupGateway> openSetup(
    WidgetTester tester, {
    SetupGateway? gateway,
  }) async {
    size(tester);
    final api = gateway ?? SetupGateway();
    await tester.pumpWidget(FarFromDeskApp(gateway: api));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Manage coordinators'));
    await tester.tap(find.text('Manage coordinators'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('+ Add coordinator'));
    await tester.pumpAndSettle();
    return api;
  }

  Finder inDialog(String text) =>
      find.descendant(of: find.byType(Dialog), matching: find.text(text));

  Future<void> continueStep(WidgetTester tester, [int times = 1]) async {
    for (var i = 0; i < times; i++) {
      await tester.ensureVisible(find.text('Continue'));
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();
    }
  }

  Future<void> pickProject(WidgetTester tester, String label) async {
    await tester.tap(find.byKey(const ValueKey('coordinator-folder-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining(label).last);
    await tester.pumpAndSettle();
  }

  Future<void> pickMuse(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('coordinator-coding-app')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Muse Code').last);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'the dialog does not repeat its own heading or offer a back button',
    (tester) async {
      await openSetup(tester);
      expect(find.text('Back to coordinators'), findsNothing);
      expect(inDialog('Add coordinator'), findsOneWidget);
      expect(inDialog('Use existing session'), findsOneWidget);
      expect(
        inDialog('Choose the apps and sessions that can answer your messages.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('the flow walks from type to configure to review', (
    tester,
  ) async {
    await openSetup(tester);
    expect(find.text('Select type'), findsNothing);
    await continueStep(tester);
    expect(find.text('Select type'), findsOneWidget);
    expect(find.text('Configure'), findsOneWidget);
    expect(find.text('Review'), findsOneWidget);
    expect(
      inDialog('Set up a new coordinator for your workspace.'),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('coordinator-name')), findsOneWidget);
    await continueStep(tester);
    expect(
      inDialog('Confirm the details before adding the coordinator.'),
      findsOneWidget,
    );
    expect(find.text('Add coordinator'), findsWidgets);
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('coordinator-name')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'a new terminal coordinator defaults to the most recent project',
    (tester) async {
      final api = await openSetup(tester);
      await continueStep(tester);
      expect(find.byKey(const ValueKey('coordinator-folder')), findsOneWidget);
      expect(find.textContaining('/sample/projects/recent'), findsOneWidget);
      await continueStep(tester);
      await tester.tap(find.text('Add coordinator'));
      await tester.pumpAndSettle();
      expect(api.submitted?['workspaceId'], 'ws-recent');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'choosing its own folder restores the private coordinator folder',
    (tester) async {
      final api = await openSetup(tester);
      await continueStep(tester);
      await pickProject(tester, 'Its own private folder');
      expect(
        find.textContaining('~/.farfromdesk/coordinators/'),
        findsOneWidget,
      );
      await continueStep(tester);
      await tester.tap(find.text('Add coordinator'));
      await tester.pumpAndSettle();
      expect(api.submitted!.containsKey('workspaceId'), isFalse);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('the type cards choose which second step appears', (
    tester,
  ) async {
    await openSetup(tester);
    expect(find.text('Set up a new coordinator'), findsOneWidget);
    await tester.tap(find.text('Use existing session'));
    await tester.pumpAndSettle();
    await continueStep(tester);
    expect(find.text('Choose session'), findsOneWidget);
    expect(find.text('Select a session'), findsOneWidget);
    expect(find.byKey(const ValueKey('coordinator-name')), findsNothing);
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add coordinator'));
    await tester.pumpAndSettle();
    await continueStep(tester);
    expect(find.text('Configure'), findsOneWidget);
    expect(find.byKey(const ValueKey('coordinator-name')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Muse runs in the chosen project and sends the trust decision', (
    tester,
  ) async {
    final api = await openSetup(tester);
    await pickMuse(tester);
    await continueStep(tester);
    // Muse Code has no desktop app, so its one connection carries no CLI suffix.
    expect(find.text('Load this project’s rules and skills'), findsOneWidget);
    await continueStep(tester);
    await tester.tap(find.text('Add coordinator'));
    await tester.pumpAndSettle();
    expect(api.submitted?['provider'], 'muse');
    expect(api.submitted?['workspaceId'], 'muse-ws');
    expect(api.submitted?['trustWorkspace'], isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a saved Muse session shows the model it will continue', (
    tester,
  ) async {
    await openSetup(tester);
    await pickMuse(tester);
    await tester.tap(find.text('Use existing session'));
    await tester.pumpAndSettle();
    await continueStep(tester);
    expect(find.textContaining('muse-spark-1.3'), findsOneWidget);
    expect(find.text('Use this session'), findsOneWidget);
    await tester.tap(find.text('Saved Muse session'));
    await tester.pumpAndSettle();
    await continueStep(tester);
    expect(
      find.textContaining('Continues the selected session'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'the picker sits beside Detect apps and carries the app state itself',
    (tester) async {
      await openSetup(tester);
      final picker = find.byKey(const ValueKey('coordinator-coding-app'));
      final pickerRect = tester.getRect(picker);
      final detectRect = tester.getRect(
        find.widgetWithText(OutlinedButton, 'Detect apps'),
      );
      // One right-aligned control group: the button starts a gap after the picker ends.
      expect(pickerRect.width, 300);
      expect(detectRect.left - pickerRect.right, closeTo(8, 0.5));
      // Readiness belongs to the picker, not to a loose badge beside the button.
      expect(
        find.descendant(of: picker, matching: find.text('Ready')),
        findsOneWidget,
      );
      await tester.tap(picker);
      await tester.pumpAndSettle();
      // The menu is the picker's own width, anchored under it, and each app states its own readiness.
      final menu = find.ancestor(
        of: find.text('Codex CLI'),
        matching: find.byType(SingleChildScrollView),
      );
      expect(menu, findsNWidgets(2));
      final menuRect = tester.getRect(menu.last);
      // Its own width exactly: the menu is inset only by its padding and border.
      expect(menuRect.width, closeTo(pickerRect.width - 14, 1));
      expect(menuRect.right, closeTo(pickerRect.right - 7, 1));
      expect(
        find.descendant(of: menu.last, matching: find.text('Ready')),
        findsWidgets,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('an app that cannot be used states why inside the menu', (
    tester,
  ) async {
    await openSetup(
      tester,
      gateway: SetupGateway()..unavailable = 'claude:desktop',
    );
    await tester.tap(find.byKey(const ValueKey('coordinator-coding-app')));
    await tester.pumpAndSettle();
    final menu = find.ancestor(
      of: find.text('Claude Desktop'),
      matching: find.byType(SingleChildScrollView),
    );
    expect(
      find.descendant(of: menu.first, matching: find.text('Needs setup')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: menu.last,
        matching: find.textContaining('not installed'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}

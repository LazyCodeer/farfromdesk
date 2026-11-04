import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/gateway.dart';
import 'package:farfromdesk/preview.dart';
import 'package:farfromdesk/updates.dart';

/// Minimal well-formed release the checker will accept.
Map<String, dynamic> release(String version) {
  final name = 'FarFromDesk-$version-macos-arm64.zip';
  final base =
      'https://github.com/$releaseRepository/releases/download/v$version';
  return {
    'tag_name': 'v$version',
    'draft': false,
    'prerelease': false,
    'assets': [
      {
        'name': name,
        'size': 5000000,
        'state': 'uploaded',
        'browser_download_url': '$base/$name',
      },
      {
        'name': '$name.sha256',
        'size': 64,
        'state': 'uploaded',
        'browser_download_url': '$base/$name.sha256',
      },
    ],
  };
}

void main() {
  group('UpdateSchedule', () {
    test('round-trips every value through its stored id', () {
      for (final option in UpdateSchedule.values) {
        expect(UpdateSchedule.fromId(option.id), option);
      }
      expect(UpdateSchedule.values.map((s) => s.id).toSet().length,
          UpdateSchedule.values.length);
    });

    test('an unknown or missing id falls back to the documented default', () {
      expect(UpdateSchedule.fromId('every-fortnight'), UpdateSchedule.hourly);
      expect(UpdateSchedule.fromId(null), UpdateSchedule.hourly);
      expect(UpdateSchedule.fromId(7), UpdateSchedule.hourly);
    });

    test('every label reads as a phrase the pane can drop into a sentence', () {
      for (final option in UpdateSchedule.values) {
        expect(option.label.toLowerCase(), startsWith('every '));
        expect(option.interval, greaterThan(updateManualFloor));
      }
    });
  });

  group('UpdatePreferences', () {
    test('survives a json round-trip', () {
      final prefs = UpdatePreferences(
        schedule: UpdateSchedule.daily,
        automatic: false,
      );
      final back = UpdatePreferences.fromJson(
        jsonDecode(jsonEncode(prefs.toJson())),
      );
      expect(back.schedule, UpdateSchedule.daily);
      expect(back.automatic, isFalse);
    });

    test('a missing automatic key means never chosen, not explicitly off', () {
      expect(UpdatePreferences.fromJson({'schedule': 'weekly'}).automatic,
          isTrue);
      expect(UpdatePreferences.fromJson(null).automatic, isTrue);
      expect(UpdatePreferences.fromJson('nonsense').schedule,
          UpdateSchedule.hourly);
    });

    test('a stored off is not resurrected by a missing schedule', () {
      final prefs = UpdatePreferences.fromJson({'automatic': false});
      expect(prefs.automatic, isFalse);
      expect(prefs.schedule, UpdateSchedule.hourly);
    });
  });

  group('the schedule is the interval that actually runs', () {
    late DateTime now;
    late int calls;

    UpdateChecker checker({
      UpdateSchedule schedule = UpdateSchedule.hourly,
      Future<void> Function(Map<String, dynamic>)? save,
    }) => UpdateChecker(
      current: '0.7.0',
      platform: 'macos',
      architecture: 'arm64',
      clock: () => now,
      schedule: schedule,
      save: save,
      clientFactory: () => MockClient((_) async {
        calls++;
        return http.Response(jsonEncode([release('0.9.0')]), 200);
      }),
    );

    setUp(() {
      now = DateTime.utc(2026, 11, 2);
      calls = 0;
    });

    test('daily waits a day where the old fixed six hours would have fired',
        () async {
      final c = checker(schedule: UpdateSchedule.daily);
      await c.check();
      expect(calls, 1);
      now = now.add(const Duration(hours: 7));
      await c.check();
      expect(calls, 1, reason: 'seven hours is not yet a day');
      now = now.add(const Duration(hours: 18));
      await c.check();
      expect(calls, 2);
      c.close();
    });

    test('hourly fires inside the window the old fixed six hours ignored',
        () async {
      final c = checker(schedule: UpdateSchedule.hourly);
      await c.check();
      now = now.add(const Duration(hours: 2));
      await c.check();
      expect(calls, 2);
      c.close();
    });

    test('changing the schedule applies without a restart', () async {
      final c = checker(schedule: UpdateSchedule.weekly);
      await c.check();
      now = now.add(const Duration(hours: 2));
      await c.check();
      expect(calls, 1, reason: 'a week has not passed');
      c.applyPreferences(
        UpdatePreferences(schedule: UpdateSchedule.hourly, automatic: true),
      );
      await c.check();
      expect(calls, 2, reason: 'the new cadence must be live immediately');
      c.close();
    });

    test('a manual press is bounded by its own floor, whatever the schedule',
        () async {
      final c = checker(schedule: UpdateSchedule.weekly);
      await c.check();
      now = now.add(const Duration(seconds: 30));
      await c.check(manual: true);
      expect(calls, 1, reason: 'inside the one-minute floor');
      now = now.add(const Duration(seconds: 45));
      await c.check(manual: true);
      expect(calls, 2);
      c.close();
    });
  });

  group('Updates pane', () {
    setUpAll(() async {
      final loader = FontLoader('MaterialIcons')
        ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
      await loader.load();
    });

    Future<void> openUpdates(WidgetTester tester, {Gateway? gateway}) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(
        tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
      );
      await tester.pumpWidget(
        FarFromDeskApp(
          gateway:
              gateway ??
              _RecordingGateway(fixture: 'connected', screen: 'settings'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('settings-tab-updates')));
      await tester.pumpAndSettle();
    }

    testWidgets('choosing a schedule persists it, not just repaints the row', (
      tester,
    ) async {
      final api = _RecordingGateway(fixture: 'connected', screen: 'settings');
      await openUpdates(tester, gateway: api);
      expect(find.textContaining('then every hour'), findsWidgets);
      await tester.tap(find.byKey(const ValueKey('setting-update-schedule')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Every day').last);
      await tester.pumpAndSettle();
      expect(
        api.saved.schedule,
        UpdateSchedule.daily,
        reason: 'the choice has to outlive the window',
      );
      expect(find.textContaining('then every day'), findsWidgets);
      expect(
        find.textContaining('then every hour'),
        findsNothing,
        reason: 'the pane must not keep describing the old cadence',
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('Check now shows it is working instead of looking dead', (
      tester,
    ) async {
      await openUpdates(tester);
      // A check fired at startup may still be settling; wait it out so the
      // button is idle before the press that is under test.
      await tester.pump(const Duration(milliseconds: 900));
      await tester.pumpAndSettle();
      expect(find.text('Check now'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('setting-check-updates')));
      await tester.pump();
      // The check itself can answer in milliseconds; the busy state has to
      // outlive the press or the button reads as broken. pumpAndSettle alone
      // returns immediately here, because a determinate spinner schedules no
      // further frames, so the floor has to be advanced explicitly.
      expect(find.text('Checking…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsWidgets);
      await tester.pump(const Duration(milliseconds: 900));
      await tester.pumpAndSettle();
      expect(find.text('Check now'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}

/// PreviewGateway plus a note of what the pane tried to store, so the test can
/// tell "the row repainted" apart from "the choice was actually saved".
class _RecordingGateway extends PreviewGateway {
  _RecordingGateway({super.fixture, super.screen});
  UpdatePreferences saved = UpdatePreferences();
  @override
  Future<void> saveUpdatePreferences(UpdatePreferences prefs) async {
    saved = prefs;
  }
}
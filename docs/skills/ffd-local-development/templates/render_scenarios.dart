// Render one FarFromDesk screen to a PNG with no permissions at all.
//
// Copied in by `ffd render <scenario>`, which deletes it again: this repo keeps
// no goldens, because a golden breaks on every unrelated UI change and, with
// another session editing the same tree, it fails for reasons that are not yours.
//
// Two details decide whether the output is useful:
//   * register a real system font under every candidate default family, or every
//     glyph is a filled box;
//   * inject the states a timer or a POST would normally produce, or the section
//     you came to look at renders empty.
//
// Button labels still render as blocks (flutter_test resolves ButtonStyle text
// through a path that ignores the registered family). That is a harness limit,
// not a product bug: assert a button's label with find.text in a widget test.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

class _Scenario {
  const _Scenario({
    this.screen = 'settings',
    this.tab = 'remote',
    this.passwordSet = false,
    this.macSupported = true,
    this.macTrusted = true,
    this.captureSupported = true,
    this.captureTrusted = false,
    this.macError,
    // [accessibility, screenRecording] as the driver reports them. Null means the
    // driver has not been probed, which is the state the page shows as "Checking…";
    // pass `driver: null` explicitly to render it.
    this.driver = const [false, true],
    this.driverCapability = const {'ok': true, 'detail': null},
    this.scrollKey,
  });
  final String screen;
  final String? tab;
  final bool passwordSet;
  final bool macSupported;
  final bool? macTrusted;
  final bool captureSupported;
  final bool? captureTrusted;
  final String? macError;
  final List<bool>? driver;
  /// The result of actually trying the driver, which is what decides the two driver
  /// rows in the pane. Null renders the "Checking…" state.
  final Map<String, dynamic>? driverCapability;
  final String? scrollKey;
}

const _scenarios = <String, _Scenario>{
  'overview': _Scenario(screen: 'overview', tab: null),
  'settings-this-mac': _Scenario(tab: 'this-mac'),
  'settings-updates': _Scenario(tab: 'updates'),
  'remote-top': _Scenario(),
  'remote-password-not-set': _Scenario(scrollKey: 'remote-password-save'),
  'remote-password-set': _Scenario(
    passwordSet: true,
    scrollKey: 'remote-password-change',
  ),
  'remote-driver-checking': _Scenario(driver: null),
  'remote-driver-failed': _Scenario(
    macTrusted: false,
    captureTrusted: true,
    driver: [false, true],
    driverCapability: const {
      'ok': false,
      'detail': 'AX_DENIED: not allowed to read windows',
    },
  ),
  'remote-permissions-missing': _Scenario(
    macTrusted: false,
    captureTrusted: false,
    driver: [false, false],
  ),
};

class _RenderGateway extends PreviewGateway {
  _RenderGateway(this.scenario)
    : super(screen: scenario.screen, fixture: 'connected');

  final _Scenario scenario;

  @override
  String get platform => 'macos';

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/remote-control') return {'state': 'idle'};
    if (path == '/api/phone-remote') {
      return {
        'supported': true,
        'passwordSet': scenario.passwordSet,
        'running': false,
        'addresses': [],
      };
    }
    final data = await super.get(path);
    if (path == '/api/status') {
      data['macControl'] = {
        'supported': scenario.macSupported,
        'enabled': scenario.macSupported && scenario.macTrusted == true,
        'trusted': scenario.macTrusted,
        'error': scenario.macError,
        'capture': {
          'supported': scenario.captureSupported,
          'trusted': scenario.captureTrusted,
        },
      };
      final driver = scenario.driver;
      data['desktopControl'] = {
        'capability': scenario.driverCapability,
        'supported': true,
        'enabled': driver != null && driver[0],
        'permission': driver == null
            ? null
            : {
                'accessibility': driver[0],
                'screenRecording': driver[1],
                'source': 'ffd render fixture',
                'checkedAt': 0,
              },
      };
    }
    return data;
  }
}

void main() {
  final name = Platform.environment['FFD_RENDER_SCENARIO'] ?? '';
  final scenario = _scenarios[name];
  if (scenario == null) {
    // Fail loudly with the list, rather than rendering something wrong.
    test('unknown scenario', () {
      fail('FFD_RENDER_SCENARIO="$name"; known: ${_scenarios.keys.join(", ")}');
    });
    return;
  }
  final size = Platform.environment['FFD_RENDER_SIZE'] ?? '1156x814';

  setUpAll(() async {
    final sys = File('/System/Library/Fonts/SFNS.ttf').readAsBytesSync();
    for (final family in [
      'Roboto',
      '.AppleSystemUIFont',
      '.SF Pro Text',
      '.SF UI Text',
      'San Francisco',
    ]) {
      await (FontLoader(family)
            ..addFont(Future.value(ByteData.sublistView(sys))))
          .load();
    }
    final mono = File('/System/Library/Fonts/SFNSMono.ttf').readAsBytesSync();
    await (FontLoader('Menlo')
          ..addFont(Future.value(ByteData.sublistView(mono))))
        .load();
    await (FontLoader('MaterialIcons')
          ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf')))
        .load();
  });

  testWidgets('render $name', (tester) async {
    final parts = size.split('x');
    tester.view.physicalSize = Size(
      double.parse(parts[0]),
      double.parse(parts[1]),
    );
    tester.view.devicePixelRatio = 1; // image pixels == logical points
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(FarFromDeskApp(gateway: _RenderGateway(scenario)));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 3)); // let the status poll land
    await tester.pumpAndSettle();
    // Assets (the brand marks) decode asynchronously, and a golden captures one
    // frame inside a fake-async zone, so the logo tiles would render blank. Give
    // the real event loop a turn, then pump again to paint what finished. A
    // multi-test harness hides this by warming the image cache on its first test.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 400)),
    );
    await tester.pumpAndSettle();
    final tab = scenario.tab;
    if (tab != null) {
      await tester.tap(find.byKey(Key('settings-tab-$tab')));
      await tester.pumpAndSettle();
    }
    final scrollKey = scenario.scrollKey;
    if (scrollKey != null) {
      await tester.ensureVisible(find.byKey(Key(scrollKey)));
      await tester.pumpAndSettle();
    }
    await expectLater(
      find.byType(MaterialApp), // the whole app: what a user sees
      matchesGoldenFile('goldens/$name.png'),
    );
  });
}
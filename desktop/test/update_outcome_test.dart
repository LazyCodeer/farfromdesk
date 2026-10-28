import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/preview.dart';

class OutcomeGateway extends PreviewGateway {
  final String phase;
  OutcomeGateway(this.phase) : super(fixture: 'connected');
  @override
  Future<Map<String, dynamic>?> updateOutcome() async {
    if (phase == 'unreadable') throw StateError('Unreadable receipt');
    return {'phase': phase, 'message': 'Verified update outcome'};
  }
}

void main() {
  setUpAll(() async {
    await (FontLoader('Onest')
          ..addFont(rootBundle.load('assets/Onest-Regular.ttf'))
          ..addFont(rootBundle.load('assets/Onest-SemiBold.ttf')))
        .load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final phase in ['complete', 'error', 'unreadable']) {
    testWidgets('startup handles $phase updater outcome', (tester) async {
      tester.view.physicalSize = const Size(1160, 820);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(FarFromDeskApp(gateway: OutcomeGateway(phase)));
      await tester.pumpAndSettle();
      if (phase != 'unreadable') {
        expect(
          find.text(
            phase == 'complete' ? 'Update complete' : 'Update needs attention',
          ),
          findsOneWidget,
        );
        expect(find.text('Verified update outcome'), findsOneWidget);
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();
      }
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }
}

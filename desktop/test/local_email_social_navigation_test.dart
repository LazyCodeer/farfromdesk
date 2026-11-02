import 'package:farfromdesk/app.dart';
import 'package:farfromdesk/local_email_screen.dart';
import 'package:farfromdesk/preview.dart';
import 'package:farfromdesk/social_preview.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class LocalPreview extends PreviewGateway {
  LocalPreview() : super(fixture: 'connected');
  @override
  bool get localEmail => true;
  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (path == '/api/local-email') return {'available': true, 'accounts': []};
    return super.get(path);
  }
}

void main() {
  testWidgets('Local can navigate between Email and Social', (tester) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(FarFromDeskApp(gateway: LocalPreview()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Email').first);
    await tester.pumpAndSettle();
    expect(find.byType(LocalEmailScreen), findsOneWidget);
    await tester.tap(find.text('Social').first);
    await tester.pumpAndSettle();
    expect(find.byType(SocialPreview), findsOneWidget);
    expect(
      tester.getSize(find.byKey(const ValueKey('navigation-rail'))).width,
      202,
    );
    expect(find.text('Bridge running'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}

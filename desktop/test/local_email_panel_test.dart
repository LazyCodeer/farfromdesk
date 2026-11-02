import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/local_email_panel.dart';

class FakeEmailGateway implements LocalEmailGateway {
  int sends = 0;
  bool failSend = false;
  EmailDraft? approved;
  final message = const EmailMessage(
    uid: 9,
    from: 'alex@example.test',
    sourceDigest: 'synthetic-digest',
    subject: 'Timeline',
    text: 'Can we meet Tuesday?',
    plainTextAvailable: true,
  );
  @override
  Future<List<EmailMessage>> inbox() async => [message];
  @override
  Future<String> summarize() async => 'Alex suggests Tuesday.';
  @override
  Future<EmailDraft> prepareReply(
    EmailMessage source,
    String to,
    String subject,
    String instruction,
    String tone,
  ) async => EmailDraft(
    id: 'draft',
    revision: 'one',
    digest: 'one',
    from: 'sagar@example.test',
    to: to,
    subject: subject,
    body: 'Tuesday works.',
  );
  @override
  Future<EmailDraft> saveDraft(
    EmailDraft draft,
    String to,
    String subject,
    String body,
  ) async => EmailDraft(
    id: draft.id,
    revision: 'two',
    digest: 'two',
    from: draft.from,
    to: to,
    subject: subject,
    body: body,
  );
  @override
  Future<String> approveAndSend(EmailDraft reviewed) async {
    sends++;
    approved = reviewed;
    if (failSend) throw Exception('unknown');
    return 'sent';
  }
}

void main() {
  testWidgets(
    'shows exact edited draft for approval and never sends on cancel',
    (tester) async {
      tester.view.physicalSize = const Size(1400, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final fake = FakeEmailGateway();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: LocalEmailPanel(gateway: fake)),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Timeline').first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Prepare reply'));
      await tester.tap(find.text('Prepare reply'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'Reply draft'),
        'Edited reply.',
      );
      await tester.ensureVisible(find.text('Review send'));
      await tester.tap(find.text('Review send'));
      await tester.pumpAndSettle();
      expect(find.textContaining('To: alex@example.test'), findsOneWidget);
      expect(
        find.textContaining('Subject: Re: Timeline\n\nEdited reply.'),
        findsOneWidget,
      );
      expect(fake.sends, 0);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(fake.sends, 0);
      await tester.tap(find.text('Review send'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approve and send'));
      await tester.pumpAndSettle();
      expect(fake.sends, 1);
      expect(fake.approved!.body, 'Edited reply.');
      expect(fake.approved!.revision, 'two');
      expect(find.textContaining('Delivery is not confirmed'), findsOneWidget);
    },
  );
  testWidgets('a failed send is shown as uncertain and is not retried', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final fake = FakeEmailGateway()..failSend = true;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: LocalEmailPanel(gateway: fake)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Timeline').first);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Prepare reply'));
    await tester.tap(find.text('Prepare reply'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Review send'));
    await tester.tap(find.text('Review send'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Approve and send'));
    await tester.pumpAndSettle();
    expect(fake.sends, 1);
    expect(find.textContaining('Send outcome is uncertain'), findsOneWidget);
    expect(find.text('Review send'), findsNothing);
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/chat_message_text.dart';

void main() {
  testWidgets('long chat messages have no inner scroll or editable animation', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              ChatMessageText(
                '*Message received*\n${List.filled(100, 'A stable paragraph.').join('\n')}\nLast line',
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(Scrollable), findsOneWidget);
    expect(find.byType(EditableText), findsNothing);
    expect(find.byType(AnimatedSwitcher), findsNothing);
    final text = tester.widget<Text>(find.byType(Text).first).textSpan!;
    expect(text.toPlainText(), startsWith('Message received\n'));
    expect(text.toPlainText(), endsWith('Last line'));
    await tester.drag(find.byType(ListView), const Offset(0, -400));
    await tester.pumpAndSettle();
    expect(
      tester.state<ScrollableState>(find.byType(Scrollable)).position.pixels,
      greaterThan(0),
    );
    expect(tester.takeException(), isNull);
  });
}

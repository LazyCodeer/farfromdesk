import 'package:flutter/material.dart';

import 'bridge_theme.dart';

/// Selectable display text without an inner editable/scrollable text field.
/// Inline emphasis is local formatting only; URLs and images are never loaded.
class ChatMessageText extends StatelessWidget {
  const ChatMessageText(this.text, {super.key, this.color = ink, this.size = 13});
  final String text;

  /// Bubble-specific ink. The default keeps the long-message renderer the same
  /// for every existing caller.
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final spans = <InlineSpan>[];
    final matches = RegExp(
      r'\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`',
    );
    var end = 0;
    for (final match in matches.allMatches(text)) {
      spans.add(TextSpan(text: text.substring(end, match.start)));
      spans.add(
        TextSpan(
          text:
              match.group(1) ??
              match.group(2) ??
              match.group(3) ??
              match.group(4),
          style: TextStyle(
            fontWeight: match.group(1) != null || match.group(2) != null
                ? FontWeight.w600
                : null,
            fontStyle: match.group(3) != null ? FontStyle.italic : null,
            fontFamily: match.group(4) != null ? 'monospace' : null,
          ),
        ),
      );
      end = match.end;
    }
    spans.add(TextSpan(text: text.substring(end)));
    return SelectionArea(
      child: Text.rich(
        TextSpan(children: spans),
        style: TextStyle(fontSize: size, height: 1.5, color: color),
      ),
    );
  }
}

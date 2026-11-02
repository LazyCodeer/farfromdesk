import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'bridge_theme.dart';

/// One row in a select menu.
class SelectOption<T> {
  const SelectOption({
    required this.value,
    required this.label,
    this.detail,
    this.leading,
    this.trailing,
    this.enabled = true,
  });

  final T value;
  final String label;

  /// A second line for anything the label cannot carry, such as a path.
  final String? detail;
  final Widget? leading;

  /// A short trailing mark, such as whether this option is ready to use.
  final Widget? trailing;
  final bool enabled;
}

/// A select that belongs to FarFromDesk rather than Material.
///
/// Material's dropdown installs a route that dims the whole window, centres itself, and grows its
/// rows to the theme's text scale, which is why it looked nothing like the rest of the app here.
/// This one anchors directly under its trigger, keeps the page undimmed and interactive-looking,
/// and gives every option one compact row with its own mark.
class FfdSelect<T> extends StatefulWidget {
  const FfdSelect({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    this.enabled = true,
    this.placeholder = 'Choose…',
    this.leading,
    this.trailing,
    this.menuWidth,
    this.alignRight = false,
    this.compact = false,
    this.labelStyle,
    this.labelKey,
  });

  final T value;
  final List<SelectOption<T>> options;
  final ValueChanged<T> onChanged;
  final bool enabled;
  final String placeholder;
  final Widget? leading;
  final Widget? trailing;

  /// Widens or narrows the menu; by default it matches the trigger.
  final double? menuWidth;

  /// Grows the menu to the left, for a trigger near the right edge of a dialog.
  final bool alignRight;
  final bool compact;
  final TextStyle? labelStyle;
  final Key? labelKey;

  @override
  State<FfdSelect<T>> createState() => _FfdSelectState<T>();
}

class _FfdSelectState<T> extends State<FfdSelect<T>> {
  final _link = LayerLink();
  OverlayEntry? _entry;
  bool _open = false;
  double _triggerWidth = 240;

  @override
  void dispose() {
    _entry?.remove();
    super.dispose();
  }

  void _toggle() {
    if (!widget.enabled) return;
    _open ? _close() : _show();
  }

  void _show() {
    _entry = OverlayEntry(builder: _menu);
    Overlay.of(context, rootOverlay: true).insert(_entry!);
    setState(() => _open = true);
  }

  void _close() {
    _entry?.remove();
    _entry = null;
    if (mounted) setState(() => _open = false);
  }

  void _choose(SelectOption<T> option) {
    _close();
    if (option.value != widget.value) widget.onChanged(option.value);
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.options
        .where((o) => o.value == widget.value)
        .firstOrNull;
    return LayoutBuilder(
      builder: (context, box) {
        _triggerWidth = box.maxWidth;
        return CompositedTransformTarget(
          link: _link,
          child: InkWell(
            onTap: _toggle,
            borderRadius: BorderRadius.circular(10),
            child: Container(
              padding: EdgeInsets.symmetric(
                horizontal: widget.compact ? 10 : 12,
                vertical: widget.compact ? 8 : 10,
              ),
              decoration: BoxDecoration(
                color: fieldColor,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: _open ? accent : line2),
              ),
              child: Row(
                children: [
                  if (widget.leading != null) ...[
                    widget.leading!,
                    const SizedBox(width: 9),
                  ],
                  Expanded(
                    child: Text(
                      current?.label ?? widget.placeholder,
                      key: widget.labelKey,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style:
                          widget.labelStyle ??
                          TextStyle(
                            fontSize: widget.compact ? 12 : 13,
                            color: widget.enabled ? ink : muted,
                          ),
                    ),
                  ),
                  if (widget.trailing != null) ...[
                    const SizedBox(width: 8),
                    widget.trailing!,
                  ],
                  const SizedBox(width: 8),
                  Icon(
                    _open ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                    size: 16,
                    color: widget.enabled ? muted : faint,
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _menu(BuildContext context) {
    // Escape closes, and a tap anywhere else does too. Nothing is dimmed: the page stays visible
    // so the owner keeps their place.
    return Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _close,
            child: const SizedBox.expand(),
          ),
        ),
        CompositedTransformFollower(
          link: _link,
          showWhenUnlinked: false,
          targetAnchor: widget.alignRight
              ? Alignment.bottomRight
              : Alignment.bottomLeft,
          followerAnchor: widget.alignRight
              ? Alignment.topRight
              : Alignment.topLeft,
          offset: const Offset(0, 6),
          child: CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.escape): _close,
            },
            child: Focus(
              autofocus: true,
              // The menu sits in the root overlay, above the dialog's own Material, and InkWell
              // cannot paint its rows without one.
              child: Material(
                type: MaterialType.transparency,
                child: Container(
                  width: widget.menuWidth ?? _triggerWidth,
                  constraints: const BoxConstraints(
                    minWidth: 200,
                    maxWidth: 420,
                    maxHeight: 300,
                  ),
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: raised,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: line),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x99000000),
                        blurRadius: 22,
                        offset: Offset(0, 10),
                      ),
                    ],
                  ),
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (final option in widget.options) _row(option),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _row(SelectOption<T> option) {
    final on = option.value == widget.value;
    return InkWell(
      onTap: option.enabled ? () => _choose(option) : null,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          color: on ? accentWash : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            if (option.leading != null) ...[
              option.leading!,
              const SizedBox(width: 10),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    option.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: on ? FontWeight.w600 : FontWeight.w500,
                      color: option.enabled ? ink : muted,
                    ),
                  ),
                  if (option.detail != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      option.detail!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: muted),
                    ),
                  ],
                ],
              ),
            ),
            if (option.trailing != null) ...[
              const SizedBox(width: 8),
              option.trailing!,
            ],
            if (on) ...[
              const SizedBox(width: 8),
              const Icon(Icons.check, size: 15, color: accent),
            ],
          ],
        ),
      ),
    );
  }
}

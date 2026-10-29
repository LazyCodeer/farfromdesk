import 'package:flutter/material.dart';

// FarFromDesk Studio design (2026-10-28): near-black surfaces, one orange
// accent, system typography. Cards are #0f0f0f with a 1px #1e1e1e inset line.
const windowColor = Color(0xff080808),
    sidebarColor = Color(0xff0b0b0b),
    panelColor = Color(0xff0f0f0f),
    dialogColor = Color(0xff0f0f0f),
    fieldColor = Color(0xff0d0d0d),
    raised = Color(0xff141414),
    ink = Color(0xfff5f5f5),
    ink2 = Color(0xffd4d4d4),
    muted = Color(0xff8f8f8f),
    faint = Color(0xff6b6b6b),
    faint2 = Color(0xff575757),
    accent = Color(0xffff6b2c),
    accentSoft = Color(0xffff8a57),
    accentInk = Color(0xffffffff),
    accentWash = Color(0x1fff6b2c),
    action = Color(0xffff6b2c),
    onAction = Color(0xffffffff),
    line = Color(0xff2a2a2a),
    line2 = Color(0xff1e1e1e),
    canvas = Color(0x06ffffff),
    surface = Color(0xff141414),
    hover = Color(0x0affffff),
    success = Color(0xff3fd68c),
    warning = Color(0xfffacc15),
    danger = Color(0xfff87171),
    sand = Color(0x1ffacc15),
    successWash = Color(0x1f3fd68c),
    hairline = Color(0xff1a1a1a),
    claudeTone = Color(0xffe08a5f),
    whatsappGreen = Color(0xff25d366);

// Tone cards. All dark now; pine marks the phone chat.
const toneCharcoal = panelColor,
    tonePine = Color(0xff1f5c44),
    toneAmber = Color(0xff1a1405);
const onPine = Color(0xfff5f5f5), onPineMuted = Color(0xffc9d6cc);

// Ink for light content (kept for onLightTone callers).
const toneInk = Color(0xff1c1d1a),
    toneMuted = Color(0xff4d4e48),
    toneAccent = Color(0xff2f5d50);

bool onLight(BuildContext c) =>
    Theme.of(c).colorScheme.brightness == Brightness.light;

/// Dark text, icons and buttons for content on the amber tone card.
Widget onLightTone(BuildContext context, Widget child) {
  final base = Theme.of(context);
  final text = base.textTheme.apply(bodyColor: toneInk, displayColor: toneInk);
  return Theme(
    data: base.copyWith(
      colorScheme: base.colorScheme.copyWith(
        brightness: Brightness.light,
        primary: toneAccent,
        onSurface: toneInk,
      ),
      textTheme: text.copyWith(
        bodySmall: text.bodySmall?.copyWith(color: toneMuted),
      ),
      iconTheme: const IconThemeData(color: toneAccent),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: toneInk,
          foregroundColor: ink,
        ).merge(base.filledButtonTheme.style),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          backgroundColor: Colors.white.withValues(alpha: .55),
          foregroundColor: toneInk,
          side: BorderSide(color: toneInk.withValues(alpha: .16)),
        ).merge(base.outlinedButtonTheme.style),
      ),
    ),
    child: DefaultTextStyle.merge(
      style: const TextStyle(color: toneInk),
      child: IconTheme(
        data: const IconThemeData(color: toneAccent),
        child: child,
      ),
    ),
  );
}

final _pill = RoundedRectangleBorder(borderRadius: BorderRadius.circular(9));
const _label = TextStyle(fontSize: 13, fontWeight: FontWeight.w600);
OutlineInputBorder _field(Color color, [double width = 1]) =>
    OutlineInputBorder(
      borderRadius: BorderRadius.circular(9),
      borderSide: BorderSide(color: color, width: width),
    );

ThemeData bridgeTheme() => ThemeData(
  useMaterial3: true,
  visualDensity: VisualDensity.standard,
  brightness: Brightness.dark,
  scaffoldBackgroundColor: windowColor,
  colorScheme: const ColorScheme.dark(
    primary: action,
    onPrimary: onAction,
    surface: panelColor,
    onSurface: ink,
    secondary: accent,
    error: danger,
  ),
  textTheme: const TextTheme(
    headlineLarge: TextStyle(
      fontSize: 22,
      height: 28 / 22,
      fontWeight: FontWeight.w600,
      letterSpacing: -.44,
      color: ink,
    ),
    titleLarge: TextStyle(
      fontSize: 14.5,
      fontWeight: FontWeight.w600,
      color: ink,
    ),
    titleMedium: TextStyle(
      fontSize: 13.5,
      fontWeight: FontWeight.w500,
      color: ink,
    ),
    bodyLarge: TextStyle(fontSize: 13.5, height: 1.5, color: ink),
    bodyMedium: TextStyle(fontSize: 13.5, height: 1.5, color: ink),
    bodySmall: TextStyle(fontSize: 12, height: 1.45, color: muted),
    labelLarge: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
  ),
  dividerColor: hairline,
  expansionTileTheme: const ExpansionTileThemeData(
    shape: Border(),
    collapsedShape: Border(),
    iconColor: muted,
    collapsedIconColor: muted,
  ),
  dividerTheme: const DividerThemeData(
    color: hairline,
    thickness: 1,
    space: 24,
  ),
  inputDecorationTheme: InputDecorationTheme(
    filled: true,
    fillColor: fieldColor,
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
    border: _field(line2),
    enabledBorder: _field(line2),
    focusedBorder: _field(accent),
    hintStyle: const TextStyle(color: faint2, fontSize: 13),
  ),
  filledButtonTheme: FilledButtonThemeData(
    style: FilledButton.styleFrom(
      backgroundColor: action,
      foregroundColor: onAction,
      disabledBackgroundColor: action.withValues(alpha: .3),
      disabledForegroundColor: ink.withValues(alpha: .45),
      minimumSize: const Size(0, 36),
      padding: const EdgeInsets.symmetric(horizontal: 16),
      textStyle: _label,
      shape: _pill,
    ),
  ),
  outlinedButtonTheme: OutlinedButtonThemeData(
    style: OutlinedButton.styleFrom(
      backgroundColor: fieldColor,
      foregroundColor: const Color(0xffe5e5e5),
      disabledForegroundColor: ink.withValues(alpha: .4),
      side: const BorderSide(color: Color(0xff232323)),
      minimumSize: const Size(0, 36),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      textStyle: _label.copyWith(fontWeight: FontWeight.w500),
      shape: _pill,
    ),
  ),
  textButtonTheme: TextButtonThemeData(
    style: TextButton.styleFrom(
      foregroundColor: ink2,
      minimumSize: const Size(0, 32),
      textStyle: _label,
      shape: _pill,
    ),
  ),
  dialogTheme: DialogThemeData(
    backgroundColor: dialogColor,
    surfaceTintColor: Colors.transparent,
    barrierColor: const Color(0xb3000000),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(16),
      side: const BorderSide(color: line2),
    ),
  ),
  popupMenuTheme: const PopupMenuThemeData(color: panelColor),
  tooltipTheme: TooltipThemeData(
    decoration: BoxDecoration(
      color: raised,
      borderRadius: BorderRadius.circular(7),
      border: Border.all(color: line),
    ),
    textStyle: const TextStyle(fontSize: 12, color: ink),
  ),
  checkboxTheme: CheckboxThemeData(
    fillColor: WidgetStateProperty.resolveWith(
      (s) => s.contains(WidgetState.selected) ? accent : Colors.transparent,
    ),
    checkColor: const WidgetStatePropertyAll(accentInk),
    side: const BorderSide(color: line, width: 1.5),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(5)),
  ),
  progressIndicatorTheme: const ProgressIndicatorThemeData(
    color: accent,
    linearTrackColor: line2,
  ),
  switchTheme: SwitchThemeData(
    thumbColor: WidgetStateProperty.resolveWith(
      (s) => s.contains(WidgetState.selected) ? Colors.white : faint,
    ),
    trackColor: WidgetStateProperty.resolveWith(
      (s) =>
          s.contains(WidgetState.selected) ? accent : const Color(0xff1e1e1e),
    ),
    trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
  ),
);

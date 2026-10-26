import 'package:flutter/material.dart';

// The website's dark theme and its "What it looks like in WhatsApp" tone cards.
// Card 03 (charcoal) is the default surface; pine marks WhatsApp and amber
// marks requests that need the owner. Body text is >= 4.5:1 on every surface.
const windowColor = Color(0xff121210),
    panelColor = Color(0xff1d1d1a),
    dialogColor = Color(0xff181815),
    ink = Color(0xfff3f1ea),
    muted = Color(0xffa7a69d),
    accent = Color(0xff86c9ad),
    accentInk = Color(0xff0f1a15),
    accentWash = Color(0x2486c9ad),
    action = Color(0xfff3f1ea),
    onAction = Color(0xff121210),
    line = Color(0xff3a3933),
    line2 = Color(0x24f3f1ea),
    canvas = Color(0x0ff4f1ea),
    surface = Color(0x14ffffff),
    hover = Color(0x0af4f1ea),
    success = Color(0xff5fcf8f),
    warning = Color(0xffe2a868),
    danger = Color(0xffff9d92),
    sand = Color(0x29e2a868),
    successWash = Color(0x245fcf8f),
    hairline = Color(0xff2a2925),
    claudeTone = Color(0xffe08a5f),
    whatsappGreen = Color(0xff25d366);

// Tone cards, flat as on the website.
const toneCharcoal = Color(0xff25241f),
    tonePine = Color(0xff2c5145),
    toneAmber = Color(0xffeab676);
const onPine = Color(0xfff4f1ea), onPineMuted = Color(0xffc9d6cc);

// Ink for the light amber card, as on the website.
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

const _pill = StadiumBorder();
const _label = TextStyle(
  fontFamily: 'DMSans',
  fontSize: 14,
  fontWeight: FontWeight.w600,
);
OutlineInputBorder _field(Color color, [double width = 1]) =>
    OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: BorderSide(color: color, width: width),
    );

ThemeData bridgeTheme() => ThemeData(
  useMaterial3: true,
  visualDensity: VisualDensity.standard,
  fontFamily: 'DMSans',
  brightness: Brightness.dark,
  scaffoldBackgroundColor: windowColor,
  colorScheme: const ColorScheme.dark(
    primary: action,
    onPrimary: onAction,
    surface: panelColor,
    onSurface: ink,
    secondary: accent,
    error: warning,
  ),
  textTheme: const TextTheme(
    headlineLarge: TextStyle(
      fontSize: 18,
      fontWeight: FontWeight.w600,
      letterSpacing: -.3,
      color: ink,
    ),
    titleLarge: TextStyle(
      fontSize: 14,
      fontWeight: FontWeight.w600,
      color: ink,
    ),
    titleMedium: TextStyle(
      fontSize: 14,
      fontWeight: FontWeight.w500,
      color: ink,
    ),
    bodyLarge: TextStyle(fontSize: 13, height: 1.5, color: ink),
    bodyMedium: TextStyle(fontSize: 13, height: 1.5, color: ink),
    bodySmall: TextStyle(fontSize: 11, height: 1.5, color: muted),
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
    fillColor: panelColor,
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
    border: _field(line2),
    enabledBorder: _field(line2),
    focusedBorder: _field(accent, 1.5),
    hintStyle: const TextStyle(color: muted, fontSize: 13.5),
  ),
  filledButtonTheme: FilledButtonThemeData(
    style: FilledButton.styleFrom(
      backgroundColor: action,
      foregroundColor: onAction,
      disabledBackgroundColor: action.withValues(alpha: .3),
      disabledForegroundColor: ink.withValues(alpha: .45),
      minimumSize: const Size(0, 38),
      padding: const EdgeInsets.symmetric(horizontal: 16),
      textStyle: _label,
      shape: _pill,
    ),
  ),
  outlinedButtonTheme: OutlinedButtonThemeData(
    style: OutlinedButton.styleFrom(
      backgroundColor: panelColor,
      foregroundColor: ink,
      disabledForegroundColor: ink.withValues(alpha: .4),
      side: const BorderSide(color: line2),
      minimumSize: const Size(0, 38),
      padding: const EdgeInsets.symmetric(horizontal: 16),
      textStyle: _label,
      shape: _pill,
    ),
  ),
  textButtonTheme: TextButtonThemeData(
    style: TextButton.styleFrom(
      foregroundColor: accent,
      minimumSize: const Size(0, 32),
      textStyle: _label,
    ),
  ),
  dialogTheme: DialogThemeData(
    backgroundColor: dialogColor,
    surfaceTintColor: Colors.transparent,
    barrierColor: const Color(0xb3060605),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(22),
      side: const BorderSide(color: line2),
    ),
  ),
  popupMenuTheme: const PopupMenuThemeData(color: panelColor),
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
    linearTrackColor: hairline,
  ),
  switchTheme: SwitchThemeData(
    thumbColor: WidgetStateProperty.resolveWith(
      (s) => s.contains(WidgetState.selected) ? onAction : muted,
    ),
    trackColor: WidgetStateProperty.resolveWith(
      (s) => s.contains(WidgetState.selected) ? accent : line,
    ),
    trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
  ),
);

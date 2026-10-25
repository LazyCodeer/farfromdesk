import 'package:flutter/material.dart';

// Visual contract: current macOS BridgeStyle / BridgeTypography, not a new theme.
const canvas = Color(0xff17181d),
    panelColor = Color(0xff202126),
    ink = Color(0xfff2f2f4),
    muted = Color(0xffa6a7ae),
    accent = Color(0xff7f91ff),
    accentWash = Color(0xff1d2031),
    action = Color(0xff5267e4),
    line = Color(0xff34353c),
    surface = Color(0xff24252b),
    hover = Color(0xff292a30),
    success = Color(0xff85c7a1),
    warning = Color(0xffe6bb83),
    sand = Color(0xff3b3027),
    successWash = Color(0xff23352c);

ThemeData bridgeTheme() => ThemeData(
  useMaterial3: true,
  fontFamily: 'DMSans',
  brightness: Brightness.dark,
  scaffoldBackgroundColor: canvas,
  colorScheme: const ColorScheme.dark(
    primary: action,
    onPrimary: Colors.white,
    surface: panelColor,
    onSurface: ink,
    secondary: accent,
    error: warning,
  ),
  textTheme: const TextTheme(
    headlineLarge: TextStyle(
      fontSize: 28,
      fontWeight: FontWeight.w500,
      letterSpacing: -.6,
      color: ink,
    ),
    titleLarge: TextStyle(
      fontSize: 15,
      fontWeight: FontWeight.w500,
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
    labelLarge: TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
  ),
  dividerTheme: const DividerThemeData(color: line, thickness: 1, space: 28),
  inputDecorationTheme: InputDecorationTheme(
    filled: true,
    fillColor: canvas,
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(9),
      borderSide: const BorderSide(color: line),
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(9),
      borderSide: const BorderSide(color: line),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(9),
      borderSide: const BorderSide(color: accent),
    ),
    hintStyle: const TextStyle(color: muted, fontSize: 13),
  ),
  filledButtonTheme: FilledButtonThemeData(
    style: FilledButton.styleFrom(
      backgroundColor: action,
      foregroundColor: Colors.white,
      disabledBackgroundColor: action.withValues(alpha: .45),
      disabledForegroundColor: ink.withValues(alpha: .45),
      minimumSize: const Size(0, 38),
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
    ),
  ),
  outlinedButtonTheme: OutlinedButtonThemeData(
    style: OutlinedButton.styleFrom(
      backgroundColor: panelColor,
      foregroundColor: ink,
      side: const BorderSide(color: line),
      minimumSize: const Size(0, 38),
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
    ),
  ),
  textButtonTheme: TextButtonThemeData(
    style: TextButton.styleFrom(foregroundColor: accent),
  ),
  dialogTheme: DialogThemeData(
    backgroundColor: panelColor,
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
  ),
  switchTheme: SwitchThemeData(
    thumbColor: WidgetStateProperty.resolveWith(
      (s) => s.contains(WidgetState.selected) ? Colors.white : muted,
    ),
    trackColor: WidgetStateProperty.resolveWith(
      (s) => s.contains(WidgetState.selected) ? action : line,
    ),
  ),
);

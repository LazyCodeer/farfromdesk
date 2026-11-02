/// Coding provider labels are three way. Muse Code is its own provider and never
/// falls through to Codex; an unknown legacy row gets a neutral label instead.
String providerLabel(Object? provider) => switch ('${provider ?? ''}') {
  'claude' => 'Claude',
  'codex' => 'Codex',
  'muse' => 'Muse Code',
  _ => 'Coding',
};

/// Brand key for the logo tile: Muse has no image asset, so it uses its glyph.
String providerBrand(Object? provider) => switch ('${provider ?? ''}') {
  'claude' => 'claude',
  'muse' => 'muse',
  _ => 'openai',
};

/// What the row is, then whether it is ready. The reason for anything not ready belongs in the
/// detail text under the form, so a diagnostic never sits where a state word is expected.
String platformModeNoun(Map platform) =>
    platform['executionMode'] == 'desktop' ? 'App' : 'Terminal';

/// Installation, native authentication and model access are separate checks.
String platformConnectionStatus(Map platform) {
  if (platform['available'] != true) return '${platformModeNoun(platform)} · Needs setup';
  final state = platform['connection']?['state'];
  if (platform['executionMode'] == 'desktop') return 'App · Ready';
  if (state == 'configured') return 'Terminal · Token ready';
  if (state == 'signed-out') return 'Terminal · Sign in required';
  if (state == 'unknown') return 'Terminal · Check required';
  if (platform['canCreate'] == false) return 'Terminal · Check configuration';
  return 'Terminal · Ready';
}

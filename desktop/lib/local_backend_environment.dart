import 'package:path/path.dart' as p;

/// Launch-time environment for the separately installed Local test app.
/// The Codex home is selected at build time after the owner opts in.
Map<String, String> localBackendEnvironment({
  required String state,
  required String codexHome,
}) {
  if (!p.isAbsolute(state) || !p.isAbsolute(codexHome)) {
    throw StateError(
      'Local state and selected Codex profile must be absolute paths.',
    );
  }
  final local = p.normalize(state);
  final profile = p.normalize(codexHome);
  if (local == profile ||
      p.isWithin(local, profile) ||
      p.isWithin(profile, local)) {
    throw StateError(
      'The selected Codex profile must be separate from Local app state.',
    );
  }
  return {
    'HOME': p.join(local, 'home'),
    'FARFROMDESK_HOME': p.join(local, 'projects'),
    'CODEX_HOME': p.join(local, 'home', '.codex'),
    'FFD_ISOLATED_LOCAL': '1',
    'FFD_SELECTED_CODEX_HOME': profile,
    'CLAUDE_CONFIG_DIR': p.join(local, 'home', '.claude'),
    'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
  };
}

part of 'app.dart';

/// Desktop control: the vendored driver's own grants, and which named sessions may
/// drive the Mac.
///
/// Both were invisible before. The pane showed only the Accessibility helper's
/// status, which does not describe the driver, so the owner could be told
/// "Allowed" while desktop control could not work at all. And nothing but the
/// WhatsApp master could reach desktop control, so no coding session could.
extension _DesktopControlPanel on _DeskState {
  List<String> get desktopControlSessions {
    final raw = status['desktopControlSessions'];
    return raw is List ? raw.whereType<String>().toList() : const <String>[];
  }

  Future<void> setDesktopControlSessions(List<String> next) =>
      post('/api/desktop-control-sessions', {'sessions': next});

  Widget desktopDriverPanel() {
    final info = Map<String, dynamic>.from(
      status['desktopControl'] as Map? ?? const {},
    );
    final permission = Map<String, dynamic>.from(
      info['permission'] as Map? ?? const {},
    );
    final checked = permission.isNotEmpty;
    Widget row(IconData icon, String name, String detail, Object? allowed) =>
        settingCard(
          icon,
          name,
          detail,
          control: !checked
              ? tag('Checking…')
              : allowed == true
              ? tag('Allowed', good: true)
              : tag('Not allowed', tint: warning),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        row(
          Icons.settings_input_component_rounded,
          'Desktop driver access',
          'Lets FarFromDesk drive another app: read its controls and, where an app '
              'publishes none, click and type at exact points.',
          permission['accessibility'],
        ),
        row(
          Icons.photo_size_select_actual_outlined,
          'Desktop driver screen access',
          'Lets FarFromDesk see a window it cannot read, which is how apps that '
              'draw their own interface are targeted.',
          permission['screenRecording'],
        ),
        gap(10),
        settingsNote(
          'macOS tracks these two grants against the desktop driver itself, '
          'separately from the Accessibility helper above. Either can be allowed '
          'while the other is not, so compare both before deciding control is broken.',
          icon: Icons.info_outline_rounded,
        ),
      ],
    );
  }

  Widget desktopControlSessionsPanel() {
    final sessions = (status['bindings'] as List? ?? const [])
        .whereType<Map>()
        .map(Map<String, dynamic>.from)
        // SQLite hands `enabled` back as 0 or 1, not a bool, so an equality test
        // against true silently drops every session and the list looks empty.
        .where((b) => b['enabled'] == true || b['enabled'] == 1)
        .toList();
    if (sessions.isEmpty) {
      return settingsNote(
        'No connected session to choose from yet.',
        icon: Icons.info_outline_rounded,
      );
    }
    final allowed = desktopControlSessions;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final session in sessions)
          settingCard(
            Icons.terminal_rounded,
            '${session['name'] ?? session['id']}',
            allowed.contains(session['id'])
                ? 'May control this Mac while working on a request it was given.'
                : 'Cannot control this Mac.',
            control: Switch(
              key: Key('desktop-control-session-${session['id']}'),
              value: allowed.contains(session['id']),
              onChanged: busy
                  ? null
                  : (on) {
                      final next = [...allowed];
                      final id = session['id'] as String;
                      if (on) {
                        if (!next.contains(id)) next.add(id);
                      } else {
                        next.remove(id);
                      }
                      setDesktopControlSessions(next);
                    },
            ),
          ),
      ],
    );
  }
}
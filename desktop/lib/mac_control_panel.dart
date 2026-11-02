part of 'app.dart';

extension _MacControlPanel on _DeskState {
  Widget macControlPanel() {
    final info = status['macControl'] ?? {};
    final trusted = info['trusted'];
    final capture = Map<String, dynamic>.from(info['capture'] ?? {});
    final failed = info['error'] != null;
    Widget permission(
      IconData icon,
      String name,
      String detail,
      bool? allowed,
      String action, {
      bool required = false,
    }) => settingCard(
      icon,
      name,
      detail,
      control: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          failed
              ? tag('Unknown', tint: warning)
              : allowed == null
              ? tag('Checking…')
              : allowed == true
              ? tag('Allowed', good: true)
              : tag('Not allowed', tint: warning),
          const SizedBox(width: 6),
          if (macChecking)
            const SizedBox(
              width: 34,
              height: 34,
              child: Center(
                child: SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            )
          else
            IconButton(
              key: Key('mac-refresh-$action'),
              tooltip: 'Refresh status',
              iconSize: 18,
              color: muted,
              onPressed: checkMac,
              icon: const Icon(Icons.refresh_rounded),
            ),
          if (!failed && allowed == false)
            IconButton(
              key: Key('mac-open-$action'),
              tooltip: 'Open System Settings',
              iconSize: 18,
              color: required ? accent : muted,
              onPressed: busy
                  ? null
                  : () => post('/api/mac-control', {'action': action}),
              icon: const Icon(Icons.open_in_new_rounded),
            ),
        ],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        permission(
          Icons.accessibility_new_rounded,
          'Accessibility',
          'Lets your proxy read and press things in the window you pick.',
          trusted as bool?,
          'permission',
          required: true,
        ),
        if (capture['supported'] != false)
          permission(
            Icons.desktop_mac_outlined,
            'Screen Recording',
            'Optional for proxy screenshots of the selected window.',
            capture['trusted'] as bool?,
            'capture-permission',
          ),
        if (failed) ...[
          gap(10),
          settingsNote(
            "Couldn't check the permissions. Nothing was changed. Refresh, or restart FarFromDesk if it keeps failing.",
            icon: Icons.error_outline_rounded,
          ),
        ],
      ],
    );
  }
}
part of 'app.dart';

/// The macOS grants that decide whether FarFromDesk can act on this Mac.
///
/// Two pairs, and macOS tracks them against different subjects: the
/// accessibility helper the proxy uses for the window the owner picks, and the
/// desktop driver's own grants, which are what desktop control really runs on.
/// They used to sit in two sections a heading apart, which read as two
/// unrelated features and made "Allowed" on one pair look like it covered the
/// other. One list now, with the driver's rows named as the driver's.
extension _MacControlPanel on _DeskState {
  Widget macControlPanel() {
    final info = status['macControl'] ?? {};
    final trusted = info['trusted'];
    final capture = Map<String, dynamic>.from(info['capture'] ?? {});
    final failed = info['error'] != null;
    final driver = Map<String, dynamic>.from(
      status['desktopControl'] as Map? ?? const {},
    );
    final driverPermission = Map<String, dynamic>.from(
      driver['permission'] as Map? ?? const {},
    );
    // An empty report means nothing has read the driver yet. The status call
    // probes it before it answers, so this only covers the first frame, and it
    // says so instead of claiming a grant nobody has read.
    final driverChecked = driverPermission.isNotEmpty;
    Widget permission(
      IconData icon,
      String name,
      String detail,
      bool? allowed, {
      required String keySuffix,
      String? action,
      bool required = false,
      bool checked = true,
    }) => settingCard(
      icon,
      name,
      detail,
      control: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          failed
              ? tag('Unknown', tint: warning)
              : !checked || allowed == null
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
              key: Key('mac-refresh-$keySuffix'),
              tooltip: 'Refresh status',
              iconSize: 18,
              color: muted,
              onPressed: checkMac,
              icon: const Icon(Icons.refresh_rounded),
            ),
          // Only the helper's grants have a System Settings pane this app can
          // open. The driver's belong to the driver, so its rows carry no button
          // rather than one that would open the wrong pane.
          if (!failed && allowed == false && action != null)
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
          keySuffix: 'permission',
          action: 'permission',
          required: true,
        ),
        if (capture['supported'] != false)
          permission(
            Icons.desktop_mac_outlined,
            'Screen Recording',
            'Optional for proxy screenshots of the selected window.',
            capture['trusted'] as bool?,
            keySuffix: 'capture-permission',
            action: 'capture-permission',
          ),
        permission(
          Icons.settings_input_component_rounded,
          'Desktop driver access',
          'Lets FarFromDesk drive another app: read its controls and, where an '
              'app publishes none, click and type at exact points.',
          driverPermission['accessibility'] as bool?,
          keySuffix: 'driver-access',
          checked: driverChecked,
        ),
        permission(
          Icons.photo_size_select_actual_outlined,
          'Desktop driver screen access',
          'Lets FarFromDesk see a window it cannot read, which is how apps that '
              'draw their own interface are targeted.',
          driverPermission['screenRecording'] as bool?,
          keySuffix: 'driver-screen',
          checked: driverChecked,
        ),
        if (failed) ...[
          gap(10),
          settingsNote(
            "Couldn't check the permissions. Nothing was changed. Refresh, or restart FarFromDesk if it keeps failing.",
            icon: Icons.error_outline_rounded,
          ),
        ],
        settingsNote(
          "macOS tracks the driver's two grants against the desktop driver "
          'itself, separately from the Accessibility helper above. Either can be '
          'allowed while the other is not, so compare both before deciding '
          'control is broken.',
        ),
      ],
    );
  }
}
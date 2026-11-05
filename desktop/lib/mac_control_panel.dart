part of 'app.dart';

/// The macOS grants that decide whether FarFromDesk can act on this Mac, and the
/// two things the desktop driver can do once they are in place.
///
/// The first two rows are grants the owner gives once: the accessibility helper's
/// Accessibility, and its Screen Recording. The two driver rows are not grants at
/// all, and used to be shown as if they were. The vendored driver runs as a child of
/// our helper and says so itself when asked:
///
///   "Embedded mode: these booleans reflect the HOST app's TCC grant (the driver is
///    a child in the host's responsibility chain). No separate driver grant exists
///    or is needed ... the driver never raises its own prompt."
///
/// Its preflight was also measured reading `accessibility: false` while an
/// accessibility read through the same driver succeeded, so the driver rows are
/// decided by trying the driver, not by asking it whether it is allowed. The vendor
/// grant path (`cua-driver permissions grant`) is unusable here as shipped: it
/// launches `/Applications/CuaDriver.app`, which this bundle does not contain.
extension _MacControlPanel on _DeskState {
  /// Windows and Linux: no operating-system grant exists, so the owner's switch is
  /// the whole opt-in, the driver row is a real read, and the limits are stated.
  Widget portableControlPanel() {
    final info = status['macControl'] ?? {};
    final driver = Map<String, dynamic>.from(
      status['desktopControl'] as Map? ?? const {},
    );
    final capability = Map<String, dynamic>.from(
      driver['capability'] as Map? ?? const {},
    );
    final limits = List<String>.from(driver['limits'] as List? ?? const []);
    final enabled = info['enabled'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        settingCard(
          Icons.settings_input_component_rounded,
          'Let FarFromDesk control apps',
          '${api.platform == 'windows' ? 'Windows' : 'Linux'} asks for no permission here, so this '
              'switch is the only gate. It lets your proxy list windows, read them, '
              'click a named button, type and take screenshots.',
          control: Switch(
            key: const Key('portable-control-enabled'),
            value: enabled,
            onChanged: busy
                ? null
                : (v) async {
                    await post('/api/mac-control', {
                      'action': v ? 'enable' : 'disable',
                    });
                    if (v) await probeDriverAccess();
                  },
          ),
          footer: [
            if (capability.isNotEmpty)
              capability['ok'] == true
                  ? tag('Reading windows works', good: true)
                  : tag('Cannot read windows', tint: warning),
            if (capability['ok'] == false && capability['detail'] != null) ...[
              gap(7),
              small(capability['detail'] as String),
            ],
            for (final line in limits) ...[gap(5), small(line)],
          ],
        ),
      ],
    );
  }

  Widget macControlPanel() {
    if (status['macControl']?['portable'] == true)
      return portableControlPanel();
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
    final driverCapability = Map<String, dynamic>.from(
      driver['capability'] as Map? ?? const {},
    );
    final grant = Map<String, dynamic>.from(
      status['grant'] as Map? ?? const {},
    );
    final driverChecked = driverCapability.isNotEmpty;
    final driverWorks = driverCapability['ok'] == true;
    final driverDetail = driverCapability['detail'] as String?;
    // Screenshots need the host's Screen Recording, which is the row above. Either
    // the driver's own reading or the helper's grant is enough: in embedded mode the
    // grant is the host's, and the driver's reading of it can lag behind.
    final seesScreens =
        driverWorks &&
        (driverPermission['screenRecording'] == true ||
            capture['trusted'] == true);
    Widget permission(
      IconData icon,
      String name,
      String detail,
      bool? allowed, {
      required String keySuffix,
      String? action,
      bool required = false,
      bool checked = true,
      List<Widget> footer = const [],
    }) => settingCard(
      icon,
      name,
      detail,
      footer: footer,
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
          if (macChecking || driverChecking)
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
              tooltip: keySuffix.startsWith('driver')
                  ? 'Test the driver now'
                  : 'Refresh status',
              iconSize: 18,
              color: muted,
              onPressed: keySuffix.startsWith('driver')
                  ? probeDriverAccess
                  : checkMac,
              icon: const Icon(Icons.refresh_rounded),
            ),
          // Whatever decides this row is the app's own grant, so the button is the
          // same one the permission rows use: it opens System Settings and asks. The
          // key follows the row, not the action, so two rows can share an action.
          if (!failed && allowed == false && action != null)
            IconButton(
              key: Key('mac-open-$keySuffix'),
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
          'Drive another app',
          "Read another app's controls and, where an app publishes none, click and "
              'type at exact points.',
          driverWorks,
          keySuffix: 'driver-access',
          action: 'permission',
          checked: driverChecked,
          footer: [
            if (!driverChecked)
              small('Testing the driver…')
            else if (driverWorks)
              small(
                'Tested just now: the driver read this Mac. It has no grant of its '
                'own, it follows the Accessibility row above.',
              )
            else
              small(
                'The driver could not read this Mac'
                '${driverDetail == null ? '' : ': $driverDetail'}. '
                'It follows the Accessibility row above, so allow FarFromDesk there '
                'and test again, and answer any macOS access prompt first.',
              ),
          ],
        ),
        permission(
          Icons.photo_size_select_actual_outlined,
          'See any window',
          'Lets FarFromDesk see a window it cannot read, which is how apps that '
              'draw their own interface are targeted.',
          seesScreens,
          keySuffix: 'driver-screen',
          action: 'capture-permission',
          checked: driverChecked,
          footer: [
            small(
              driverWorks
                  ? 'Screenshots follow the Screen Recording row above.'
                  : 'Waiting for the driver test above.',
            ),
          ],
        ),
        // On in System Settings, yet every check fails: a grant pinned to an earlier
        // build's signature. Only the owner can clear it; this button is their click.
        if (grant.isNotEmpty) ...[
          gap(10),
          settingsNote(
            [
              grant['summary'] ?? '',
              for (final (i, step) in List<String>.from(
                grant['steps'] ?? const [],
              ).indexed)
                '${i + 1}. $step',
            ].join('\n'),
            icon: Icons.warning_amber_rounded,
          ),
          gap(8),
          button(
            'Reset and re-allow',
            () => post('/api/mac-control', {'action': 'reset-permission'}),
            primary: true,
            compact: true,
            icon: Icons.restart_alt_rounded,
            key: const Key('mac-reset-permission'),
          ),
        ],
        if (failed) ...[
          gap(10),
          settingsNote(
            "Couldn't check the permissions. Nothing was changed. Refresh, or restart FarFromDesk if it keeps failing.",
            icon: Icons.error_outline_rounded,
          ),
        ],
        settingsNote(
          'The driver runs as a child of the FarFromDesk helper, so macOS records '
          'these against FarFromDesk itself and it has no separate grant to allow. '
          'The rows above are the grants; the two below them are tested, not assumed.',
        ),
      ],
    );
  }
}

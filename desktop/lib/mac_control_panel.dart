part of 'app.dart';

extension _MacControlPanel on _DeskState {
  Widget macControlPanel() {
    final info = status['macControl'] ?? {};
    final enabled = info['enabled'] == true;
    final trusted = info['trusted'];
    final capture = Map<String, dynamic>.from(info['capture'] ?? {});
    final failed = enabled && info['error'] != null;
    const bad = Color(0xffff9d92);
    final state = !enabled
        ? tag('Off')
        : failed
        ? tag('Check failed', tint: bad)
        : trusted == true
        ? tag('Ready', good: true)
        : trusted == null
        ? tag('Checking…')
        : tag('Needs permission', tint: warning);
    Widget permission(
      String name,
      String detail,
      bool? allowed,
      String action, {
      bool required = false,
    }) => Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: const Color(0x0af4f1ea),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: hairline),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                gap(2),
                small(detail),
              ],
            ),
          ),
          const SizedBox(width: 12),
          failed
              ? tag('Unknown', tint: bad)
              : allowed == null
              ? tag('Checking…')
              : allowed == true
              ? tag('Allowed', good: true)
              : tag('Not allowed', tint: required ? warning : null),
          const SizedBox(width: 4),
          macChecking
              ? const SizedBox(
                  width: 40,
                  height: 40,
                  child: Center(
                    child: SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                )
              : IconButton(
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
              icon: const Icon(Icons.settings_outlined),
            ),
        ],
      ),
    );
    return panel(
      'Mac control',
      trailing: state,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          settingRow(
            'Let your proxy use apps on this Mac',
            'It only works in the app window you pick from your phone.',
            Switch(
              key: const Key('mac-control-enabled'),
              value: enabled,
              onChanged: (v) async {
                if (v) {
                  if (!busy) {
                    await post('/api/mac-control', {'action': 'enable'});
                  }
                  return;
                }
                // Turning off is the emergency stop: it must work while another action is busy.
                try {
                  await api.post('/api/mac-control', {'action': 'disable'});
                  if (mounted) {
                    _macUpdate(() {
                      status['macControl'] = {...info, 'enabled': false};
                    });
                  }
                } catch (e) {
                  if (mounted) _macUpdate(() => actionError = clean(e));
                }
              },
            ),
          ),
          gap(10),
          button(
            'Remote Desktop settings',
            () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => RemoteDesktopPage(gateway: api),
              ),
            ),
            compact: true,
            key: const Key('remote-desktop-settings'),
          ),
          if (!enabled) ...[
            gap(8),
            small(
              'It can read the buttons and fields in that window, press buttons, fill text fields, scroll, and take a screenshot of that window if you allow it. It never touches passwords, payments, deleting data, sending messages, accepting terms, or system dialogs and settings.',
            ),
          ] else ...[
            permission(
              'Accessibility',
              trusted == true
                  ? 'Your proxy can read and press things in the window you pick.'
                  : 'Required. Lets your proxy read and press things in the window you pick.',
              trusted as bool?,
              'permission',
              required: true,
            ),
            if (capture['supported'] != false)
              permission(
                'Screen Recording',
                capture['trusted'] == true
                    ? 'Your proxy can send screenshots of the window you pick. Never the whole screen.'
                    : 'Optional. Only for screenshots of that window. Everything else works without it.',
                capture['trusted'] as bool?,
                'capture-permission',
              ),
            if (failed) ...[
              gap(12),
              small(
                "Couldn't check the permissions. Nothing was changed. Refresh, or restart FarFromDesk if it keeps failing.",
              ),
            ],
          ],
        ],
      ),
    );
  }
}

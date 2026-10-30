part of 'app.dart';

extension _MacControlPanel on _DeskState {
  Widget macControlPanel() {
    final info = status['macControl'] ?? {};
    final trusted = info['trusted'];
    final capture = Map<String, dynamic>.from(info['capture'] ?? {});
    final failed = info['error'] != null;
    const bad = Color(0xffff9d92);
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        small(
          'App control uses these Mac permissions for the window you select.',
        ),
        permission(
          'Accessibility',
          'Required. Lets your proxy read and press things in the window you pick.',
          trusted as bool?,
          'permission',
          required: true,
        ),
        if (capture['supported'] != false)
          permission(
            'Screen Recording',
            'Required for phone screen control. Optional for proxy screenshots of the selected window.',
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
    );
  }
}

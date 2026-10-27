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
              : allowed == true
              ? tag('Allowed', good: true)
              : tag('Not allowed', tint: required ? warning : null),
          if (!failed && allowed != true) ...[
            const SizedBox(width: 10),
            button(
              'Open settings',
              () => post('/api/mac-control', {'action': action}),
              compact: true,
              primary: required,
              key: Key('mac-open-$action'),
            ),
          ],
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
              onChanged: busy
                  ? null
                  : (v) => post('/api/mac-control', {
                      'action': v ? 'enable' : 'disable',
                    }),
            ),
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
              trusted == true,
              'permission',
              required: true,
            ),
            if (capture['supported'] != false)
              permission(
                'Screen Recording',
                capture['trusted'] == true
                    ? 'Your proxy can send screenshots of the window you pick. Never the whole screen.'
                    : 'Optional. Only for screenshots of that window. Everything else works without it.',
                capture['trusted'] == true,
                'capture-permission',
              ),
            gap(12),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                button(
                  'Check again',
                  () => post('/api/mac-control', {'action': 'check'}),
                  compact: true,
                ),
                small(
                  failed
                      ? "Couldn't check the permissions. Nothing was changed. Try again, or restart FarFromDesk if it keeps failing."
                      : trusted == true
                      ? 'Browser tabs may also ask for Automation the first time. macOS asks you then.'
                      : 'Turn FarFromDesk on in System Settings › Privacy & Security, then check again. macOS asks you, not FarFromDesk.',
                ),
              ],
            ),
            if (!failed && trusted != true) ...[
              gap(10),
              small(
                'Already allowed it? After an update, macOS can keep allowing the old version. Remove FarFromDesk from that list, add it again with +, then check again.',
              ),
            ],
            if (trusted == true && !failed)
              ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: const Text('Try it safely'),
                subtitle: const Text(
                  'Ask your proxy to type here or press the button. Nothing is sent or saved.',
                ),
                childrenPadding: const EdgeInsets.only(bottom: 12),
                children: [
                  TextField(
                    maxLength: 120,
                    decoration: const InputDecoration(
                      labelText: 'Practice field',
                      hintText: 'Practice text',
                    ),
                  ),
                  gap(8),
                  FilledButton(
                    onPressed: () =>
                        _macUpdate(() => macTrialPressed = !macTrialPressed),
                    child: Text(
                      macTrialPressed ? 'Pressed' : 'Practice button',
                    ),
                  ),
                ],
              ),
            const Divider(height: 28, color: hairline),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                OutlinedButton.icon(
                  onPressed: () async {
                    // The emergency stop must remain usable while another UI action is busy.
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
                  style: OutlinedButton.styleFrom(
                    backgroundColor: const Color(0x24e85d50),
                    foregroundColor: const Color(0xffffb4ab),
                    side: const BorderSide(color: Color(0x73ff8a80)),
                  ),
                  icon: const Icon(Icons.stop_rounded, size: 18),
                  label: const Text('Stop and turn off'),
                ),
                small(
                  'Stops any action in progress and forgets the chosen windows. An action already sent may have happened, so check the window before asking again.',
                ),
              ],
            ),
          ],
          gap(12),
          button('Remote Desktop settings', () async {
            await Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => RemoteDesktopPage(gateway: api),
              ),
            );
          }, compact: true),
        ],
      ),
    );
  }
}

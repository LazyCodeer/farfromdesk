part of 'app.dart';

extension _MacControlPanel on _DeskState {
  Widget macControlPanel() {
    final info = status['macControl'] ?? {};
    final enabled = info['enabled'] == true;
    final trusted = info['trusted'];
    final permission = trusted == true
        ? 'Accessibility permission granted'
        : trusted == false
        ? 'Accessibility permission needed'
        : 'Permission not checked';
    return panel(
      'Mac control',
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          settingRow(
            'Control apps from your phone',
            'Choose apps and browser tabs for your requests. Off by default.',
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
          gap(8),
          tag(
            enabled ? permission : 'Mac control is off',
            good: enabled && trusted == true,
          ),
          gap(12),
          small(
            'Grant Accessibility to use selected app controls. Browser tab commands may also need macOS Automation access. Screen Recording is separate and only needed for screenshots. FarFromDesk never changes these permissions for you.',
          ),
          if (info['error'] != null) ...[
            gap(8),
            small('Permission check: ${info['error']}'),
          ],
          gap(12),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [
              button(
                'Check permission',
                () => post('/api/mac-control', {'action': 'check'}),
                compact: true,
              ),
              if (enabled && trusted != true)
                button(
                  'Open Accessibility settings',
                  () => post('/api/mac-control', {'action': 'permission'}),
                  compact: true,
                ),
              if (enabled)
                button(
                  'Screen Recording settings',
                  () => post('/api/mac-control', {'action': 'capture-permission'}),
                  compact: true,
                ),
              if (enabled)
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
                  icon: const Icon(Icons.stop_circle_outlined, size: 18),
                  label: const Text('Stop and disable'),
                ),
            ],
          ),
          gap(8),
          small(
            'Stopping clears selected targets. An action already sent may have taken effect; inspect before retrying. Permission changes may require another check or a relaunch.',
          ),
          if (enabled)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text('Try safely in this window'),
              subtitle: const Text(
                'These controls do not send or save anything.',
              ),
              childrenPadding: const EdgeInsets.only(bottom: 12),
              children: [
                TextField(
                  maxLength: 120,
                  decoration: const InputDecoration(
                    labelText: 'Mac control test field',
                    hintText: 'Practice text',
                  ),
                ),
                gap(8),
                FilledButton(
                  onPressed: () =>
                      _macUpdate(() => macTrialPressed = !macTrialPressed),
                  child: Text(
                    macTrialPressed
                        ? 'Test button pressed'
                        : 'Mac control test button',
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

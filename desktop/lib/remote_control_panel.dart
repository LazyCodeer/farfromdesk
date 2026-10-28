part of 'app.dart';

/// Phone access to this Mac. One remote password guards both ways in:
/// the chat link (peer to peer, works from anywhere) and the same Wi-Fi
/// preview. All state comes from the backend; this only renders and asks.
extension _RemoteControl on _DeskState {
  bool get remoteSupported => phoneRemote['supported'] == true;
  bool get remotePasswordSet => phoneRemote['passwordSet'] == true;

  Future<void> loadRemote() async {
    final epoch = remoteEpoch;
    try {
      final link = await api.get('/api/remote-control');
      final phone = await api.get('/api/phone-remote');
      if (!mounted || epoch != remoteEpoch) return;
      changeView(() {
        remoteLink = link;
        phoneRemote = phone;
        final addresses = phone['addresses'] as List? ?? [];
        if (phoneAddress != null &&
            !addresses.any((a) => a['address'] == phoneAddress)) {
          phoneAddress = null;
        }
        if (!phoneAddressInitialized && addresses.isNotEmpty) {
          phoneAddressInitialized = true;
          if (addresses.length == 1) {
            phoneAddress = addresses.first['address'] as String?;
          }
        }
      });
    } catch (_) {
      // Older backends have no remote control; the section stays hidden.
    }
  }

  Future<void> remoteRun(
    Future<void> Function() action, {
    bool interrupt = false,
  }) async {
    if (remoteBusy && !interrupt) return;
    final epoch = ++remoteEpoch;
    changeView(() {
      remoteBusy = true;
      remoteError = null;
    });
    try {
      await action();
      if (epoch != remoteEpoch) return;
      await loadRemote();
    } catch (e) {
      if (mounted && epoch == remoteEpoch) {
        changeView(() => remoteError = remoteMessage(clean(e)));
      }
    } finally {
      if (mounted && epoch == remoteEpoch) changeView(() => remoteBusy = false);
    }
  }

  Future<Map<String, dynamic>> phoneCommand(Map<String, dynamic> data) async {
    final epoch = remoteEpoch;
    final result = await api.post('/api/phone-remote', data);
    if (epoch != remoteEpoch) {
      throw StateError('This operation was superseded.');
    }
    return result;
  }

  String remoteMessage(String code) =>
      const {
        'SELECT_APP': 'Pick an app first.',
        'SELECT_WINDOW': 'Pick a window first.',
        'SELECT_LOCAL_NETWORK': 'Pick the Wi-Fi network your phone is on.',
        'START_IN_PROGRESS': 'Already starting. Give it a moment.',
        'START_CANCELLED': 'Start was cancelled.',
        'MAC_ONLY': 'Phone access works on a Mac for now.',
        'STOPPED': 'You stopped it.',
        'NEW_LINK': 'A newer link replaced it.',
        'REPLACED': 'A newer connection replaced it.',
        'LOCKED': 'This Mac was locked.',
      }[code] ??
      code;

  Future<void> saveRemotePassword() async {
    final value = remotePassword.text;
    if (value.length < 12 || value != remoteConfirm.text) {
      changeView(
        () => remoteError =
            'Use at least 12 characters and type the same password twice.',
      );
      return;
    }
    await remoteRun(() async {
      await phoneCommand({'action': 'password', 'password': value});
      remotePassword.clear();
      remoteConfirm.clear();
      changingRemotePassword = false;
    });
  }

  List<Widget> remoteControlPanels() => [
    if (remoteError != null) ...[
      Text(remoteError!, style: const TextStyle(color: Color(0xffff9d92))),
      gap(12),
    ],
    remotePasswordPanel(),
    gap(14),
    remoteLinkPanel(),
    gap(14),
    wifiPreviewPanel(),
  ];

  Widget remotePasswordPanel() {
    final editing = !remotePasswordSet || changingRemotePassword;
    return panel(
      'Remote password',
      trailing: remotePasswordSet
          ? tag('Set', good: true)
          : tag('Not set', tint: warning),
      editing
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                small(
                  'Your phone asks for it on every new connection. Use a separate password, not your Mac login.',
                ),
                gap(12),
                TextField(
                  key: const Key('remote-password'),
                  controller: remotePassword,
                  obscureText: true,
                  enableSuggestions: false,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Password, at least 12 characters',
                  ),
                ),
                gap(8),
                TextField(
                  key: const Key('remote-password-confirm'),
                  controller: remoteConfirm,
                  obscureText: true,
                  enableSuggestions: false,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Confirm password',
                  ),
                  onSubmitted: (_) => saveRemotePassword(),
                ),
                gap(12),
                Wrap(
                  spacing: 8,
                  children: [
                    button(
                      'Save password',
                      saveRemotePassword,
                      enabled: !remoteBusy,
                      primary: true,
                      compact: true,
                      key: const Key('remote-password-save'),
                    ),
                    if (remotePasswordSet)
                      button(
                        'Cancel',
                        () => changeView(() {
                          changingRemotePassword = false;
                          remotePassword.clear();
                          remoteConfirm.clear();
                        }),
                        compact: true,
                      ),
                  ],
                ),
              ],
            )
          : settingRow(
              'Asked on your phone every time',
              'Changing it ends any phone session that is open now.',
              button(
                'Change',
                () => changeView(() => changingRemotePassword = true),
                compact: true,
              ),
            ),
    );
  }

  Widget remoteLinkPanel() {
    final state = remoteLink['state'] ?? 'idle';
    final active = ['offered', 'connecting', 'connected'].contains(state);
    final reason = remoteLink['reason'] as String?;
    return panel(
      'From anywhere',
      trailing: switch (state) {
        'offered' => tag('Link sent', tint: warning),
        'connecting' => tag('Connecting', spinning: true),
        'connected' => tag('Connected', good: true),
        _ => remotePasswordSet ? tag('Ready', good: true) : tag('Off'),
      },
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          remoteStep(
            1,
            'Send "control my screen" to FarFromDesk in $channelName.',
          ),
          remoteStep(2, 'Open the link it sends on your phone.'),
          remoteStep(3, 'Send back the code the phone page shows.'),
          remoteStep(4, 'Enter your remote password on the phone.'),
          if (!remotePasswordSet) ...[
            gap(8),
            small('Set a remote password above first.'),
          ],
          if (state == 'offered') ...[
            gap(8),
            small(
              'Waiting for the code from your phone. The link expires after 5 minutes.',
            ),
          ],
          if (state == 'ended' && reason != null) ...[
            gap(8),
            small('Last session ended. ${remoteMessage(reason)}'),
          ],
          if (active) ...[
            gap(12),
            button(
              'Stop phone access',
              () => remoteRun(
                () => api.post('/api/remote-control', {}),
                interrupt: true,
              ),
              ignoreBusy: true,
              destructive: true,
              compact: true,
              icon: Icons.stop_rounded,
              key: const Key('remote-link-stop'),
            ),
          ],
        ],
      ),
    );
  }

  Widget remoteStep(int n, String text) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 20,
          height: 20,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: hairline),
          ),
          child: Text('$n', style: const TextStyle(fontSize: 11, color: muted)),
        ),
        const SizedBox(width: 10),
        Expanded(child: Text(text, style: const TextStyle(fontSize: 13))),
      ],
    ),
  );

  Widget wifiPreviewPanel() {
    final running = phoneRemote['running'] == true;
    final phoneConnected = phoneRemote['connected'] == true;
    final addresses = phoneRemote['addresses'] as List? ?? [];
    final url = phoneRemote['url']?.toString() ?? '';
    final selectedPid = phoneApps.any((a) => a['pid'] == phonePid)
        ? phonePid
        : null;
    final selectedWindow = phoneWindows.any((w) => w['id'] == phoneWindowId)
        ? phoneWindowId
        : null;
    final selectedAddress = addresses.any((a) => a['address'] == phoneAddress)
        ? phoneAddress
        : null;
    final allowed =
        status['macControl']?['trusted'] == true &&
        status['macControl']?['capture']?['trusted'] == true;
    DropdownMenuItem<T> item<T>(T value, String label) => DropdownMenuItem<T>(
      value: value,
      child: Text(label, overflow: TextOverflow.ellipsis),
    );
    return panel(
      'Same Wi-Fi preview',
      subtitle: 'Faster to try. Shares one window you pick.',
      trailing: running
          ? phoneConnected
                ? tag('Phone connected', good: true)
                : tag('Waiting for phone', spinning: true)
          : tag('Off'),
      running
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                small(
                  'Open this address on your phone, then enter your remote password.',
                ),
                gap(8),
                Row(
                  children: [
                    Expanded(
                      child: SelectableText(
                        url,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Copy address',
                      iconSize: 18,
                      color: muted,
                      onPressed: () =>
                          Clipboard.setData(ClipboardData(text: url)),
                      icon: const Icon(Icons.copy_rounded),
                    ),
                  ],
                ),
                gap(8),
                small(
                  'Your phone may warn about the certificate. Allow it only if the fingerprint matches:',
                ),
                SelectableText(
                  phoneRemote['fingerprint']?.toString() ?? '',
                  style: const TextStyle(fontSize: 11, color: muted),
                ),
                gap(12),
                button(
                  'Stop phone access',
                  () => remoteRun(
                    () => phoneCommand({'action': 'stop'}),
                    interrupt: true,
                  ),
                  ignoreBusy: true,
                  destructive: true,
                  compact: true,
                  icon: Icons.stop_rounded,
                  key: const Key('wifi-stop'),
                ),
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (!allowed) ...[
                  small(
                    'Needs Accessibility and Screen Recording. Turn on Mac control above and allow both.',
                  ),
                  gap(12),
                ],
                Row(
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<int>(
                        key: ValueKey(
                          'app-$selectedPid-${phoneApps.map((a) => a['pid']).join(',')}',
                        ),
                        initialValue: selectedPid,
                        isExpanded: true,
                        decoration: const InputDecoration(labelText: 'App'),
                        items: [
                          for (final a in phoneApps)
                            item<int>(a['pid'] as int, '${a['name']}'),
                        ],
                        onChanged: remoteBusy
                            ? null
                            : (pid) => remoteRun(() async {
                                phonePid = pid;
                                phoneWindowId = null;
                                phoneWindows = [];
                                final r = await phoneCommand({
                                  'action': 'windows',
                                  'pid': pid,
                                });
                                phoneWindows = r['windows'] ?? [];
                              }),
                      ),
                    ),
                    IconButton(
                      key: const Key('wifi-find-apps'),
                      tooltip: 'Find open apps',
                      iconSize: 18,
                      color: muted,
                      onPressed: remoteBusy || !allowed
                          ? null
                          : () => remoteRun(() async {
                              final r = await phoneCommand({'action': 'apps'});
                              phoneApps = r['apps'] ?? [];
                              phonePid = null;
                              phoneWindowId = null;
                              phoneWindows = [];
                            }),
                      icon: const Icon(Icons.refresh_rounded),
                    ),
                  ],
                ),
                gap(10),
                DropdownButtonFormField<int>(
                  key: ValueKey(
                    'window-$phonePid-$selectedWindow-${phoneWindows.map((w) => w['id']).join(',')}',
                  ),
                  initialValue: selectedWindow,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Window'),
                  items: [
                    for (final w in phoneWindows)
                      item<int>(w['id'] as int, '${w['title']}'),
                  ],
                  onChanged: remoteBusy
                      ? null
                      : (id) => changeView(() => phoneWindowId = id),
                ),
                gap(10),
                DropdownButtonFormField<String>(
                  key: ValueKey(
                    'net-$selectedAddress-${addresses.map((a) => a['address']).join(',')}',
                  ),
                  initialValue: selectedAddress,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Wi-Fi network'),
                  items: [
                    for (final a in addresses)
                      item<String>(
                        a['address'] as String,
                        '${a['name']}  ${a['address']}',
                      ),
                  ],
                  onChanged: remoteBusy
                      ? null
                      : (v) => changeView(() => phoneAddress = v),
                ),
                if (phoneRemote['error'] != null) ...[
                  gap(10),
                  small(
                    "Couldn't start. ${remoteMessage('${phoneRemote['error']}')}",
                  ),
                ],
                gap(14),
                button(
                  'Start preview',
                  () => remoteRun(
                    () => phoneCommand({
                      'action': 'start',
                      'pid': selectedPid,
                      'windowId': selectedWindow,
                      'address': selectedAddress,
                    }),
                  ),
                  enabled:
                      !remoteBusy &&
                      allowed &&
                      remotePasswordSet &&
                      selectedPid != null &&
                      selectedWindow != null &&
                      selectedAddress != null,
                  primary: true,
                  compact: true,
                  key: const Key('wifi-start'),
                ),
              ],
            ),
    );
  }
}

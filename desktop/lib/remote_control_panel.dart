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
    remoteControlCard(),
  ];

  Widget remoteControlCard() {
    final state = remoteLink['state'] ?? 'idle';
    final stateTag = switch (state) {
      'offered' => tag('Link sent', tint: warning),
      'connecting' => tag('Connecting', spinning: true),
      'connected' => tag('Connected', good: true),
      _ => remotePasswordSet ? tag('Ready', good: true) : tag('Off'),
    };
    return panel(
      'Control from anywhere',
      subtitle: remotePasswordSet
          ? 'Your phone asks for the remote password on every new connection.'
          : 'Set a remote password to get started.',
      trailing: stateTag,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          LayoutBuilder(
            builder: (context, constraints) {
              if (constraints.maxWidth < 600) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    remotePasswordContents(),
                    const Divider(height: 32),
                    remoteLinkContents(),
                  ],
                );
              }
              return IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: remotePasswordContents()),
                    Container(
                      width: 1,
                      margin: const EdgeInsets.symmetric(horizontal: 20),
                      color: line2,
                    ),
                    Expanded(child: remoteLinkContents()),
                  ],
                ),
              );
            },
          ),
          if (phoneRemote['running'] == true) ...[
            const Divider(height: 32),
            settingRow(
              'An existing local phone session is active',
              'Stop this session when you are finished.',
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
            ),
          ],
        ],
      ),
    );
  }

  Widget remotePasswordContents() {
    final editing = !remotePasswordSet || changingRemotePassword;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                'Remote password',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
            remotePasswordSet
                ? tag('Set', good: true)
                : tag('Not set', tint: warning),
          ],
        ),
        gap(8),
        if (editing) ...[
          small(
            'Use a separate password, not your $computer login. Your phone asks for it on each new connection.',
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
            decoration: const InputDecoration(labelText: 'Confirm password'),
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
        ] else ...[
          small('Changing it ends any phone session that is open now.'),
          gap(12),
          button(
            'Change',
            () => changeView(() => changingRemotePassword = true),
            compact: true,
          ),
        ],
      ],
    );
  }

  Widget remoteLinkContents() {
    final state = remoteLink['state'] ?? 'idle';
    final active = ['offered', 'connecting', 'connected'].contains(state);
    final reason = remoteLink['reason'] as String?;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Connect from your phone',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
        gap(8),
        small(
          remotePasswordSet
              ? 'Send the request from your connected chat:'
              : 'Once your password is set:',
        ),
        gap(14),
        remoteStep(
          1,
          'Send "control my screen" to FarFromDesk in $channelName.',
        ),
        remoteStep(2, 'Open the link it sends on your phone.'),
        remoteStep(3, 'Send back the code the phone page shows.'),
        remoteStep(4, 'Enter your remote password on the phone.'),
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
}

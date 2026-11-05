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
      Map<String, dynamic> legacy = {};
      try {
        legacy = await api.get('/api/remote-desktop');
      } catch (_) {
        /* Older backends may not have it. */
      }
      if (!mounted || epoch != remoteEpoch) return;
      changeView(() {
        remoteLink = link;
        phoneRemote = phone;
        legacyRemote = legacy;
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

  /// Which of the three setup steps are already done, read from real state so
  /// the stepper never claims progress the backend does not have.
  ({bool permissions, bool password, bool connected}) remoteSetupState() {
    final mac = status['macControl'] ?? {};
    final capture = Map<String, dynamic>.from(mac['capture'] ?? {});
    final accessibility = mac['trusted'] == true;
    final screenRecording =
        capture['supported'] == false || capture['trusted'] == true;
    return (
      permissions: accessibility && screenRecording,
      password: remotePasswordSet,
      connected: (remoteLink['state'] ?? 'idle') == 'connected',
    );
  }

  List<Widget> remoteControlPanels() {
    final done = remoteSetupState();
    return [
      if (remoteError != null) ...[
        Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: sand,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            remoteError!,
            style: const TextStyle(fontSize: 12.5, color: Color(0xffff9d92)),
          ),
        ),
        gap(12),
      ],
      // Phone screen control needs the macOS capture and input helpers. Offering
      // its password and connect steps elsewhere only led to a Set password
      // button that the backend refuses (MAC_ONLY).
      if (remoteSupported)
        remoteSetupCard(done)
      else
        KeyedSubtree(
          key: const Key('remote-unavailable'),
          child: settingCard(
            Icons.phonelink_off_outlined,
            'Phone screen control works on Mac today',
            'Windows and Linux are next. Until then there is no remote password '
                'to set on this computer. The switch below still lets '
                'FarFromDesk read and use apps here when you ask from your phone.',
          ),
        ),
      if (status['macControl']?['supported'] == true) ...[
        gap(24),
        settingsSubheading(
          'Permissions',
          remoteSupported
              ? 'Required to allow remote access and screen control.'
              : 'Required for FarFromDesk to use apps on this computer.',
        ),
        gap(12),
        macControlPanel(),
      ],
      if (remoteSupported) ...[gap(26), remoteColumns()],
      if (legacyRemote['enabled'] == true) ...[
        gap(16),
        settingCard(
          Icons.desktop_windows_outlined,
          'Earlier Remote Desktop access is enabled',
          'Review or turn off the earlier Remote Desktop connection.',
          control: button(
            'Manage',
            () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => RemoteDesktopPage(gateway: api)),
            ),
            compact: true,
            key: const Key('remote-desktop-settings'),
          ),
        ),
      ],
      if (phoneRemote['running'] == true) ...[
        gap(10),
        settingCard(
          Icons.wifi_tethering_rounded,
          'An existing local phone session is active',
          'Stop this session when you are finished.',
          control: button(
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
    ];
  }

  /// The three steps as the owner sees them: what is left to do sits beside the
  /// sentence that says what this panel is for.
  Widget remoteSetupCard(
    ({bool permissions, bool password, bool connected}) done,
  ) {
    final complete = done.permissions && done.password && done.connected;
    final heading = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          complete ? 'Remote control is set up' : 'Setup remote control',
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        gap(5),
        Text(
          complete
              ? 'Permissions, password and phone are all in place.'
              : 'Grant permissions, set a remote password, and connect your phone.',
          style: const TextStyle(fontSize: 12.5, height: 1.45, color: muted),
        ),
      ],
    );
    final steps = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        remoteStepNode(
          1,
          'Permissions',
          done: done.permissions,
          current: !done.permissions,
        ),
        remoteStepLine(done.permissions),
        remoteStepNode(
          2,
          'Password',
          done: done.password,
          current: done.permissions && !done.password,
        ),
        remoteStepLine(done.password),
        remoteStepNode(
          3,
          'Connect',
          done: done.connected,
          current: done.password && !done.connected,
        ),
      ],
    );
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 20),
      decoration: BoxDecoration(
        color: accentWash,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: accent.withValues(alpha: .4)),
      ),
      child: LayoutBuilder(
        builder: (context, box) => box.maxWidth < 720
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [heading, gap(20), steps],
              )
            : Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  SizedBox(width: 300, child: heading),
                  const SizedBox(width: 32),
                  Expanded(child: steps),
                ],
              ),
      ),
    );
  }

  Widget remoteStepNode(
    int n,
    String label, {
    bool done = false,
    bool current = false,
  }) {
    final color = done ? success : current ? accent : faint;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: done
                ? successWash
                : current
                ? accent
                : Colors.transparent,
            border: Border.all(color: current ? accent : color),
          ),
          child: done
              ? const Icon(Icons.check_rounded, size: 17, color: success)
              : Text(
                  '$n',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: current ? onAction : faint,
                  ),
                ),
        ),
        gap(9),
        Text(
          label,
          style: const TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: ink,
          ),
        ),
      ],
    );
  }

  Widget remoteStepLine(bool filled) => Expanded(
    child: Padding(
      padding: const EdgeInsets.only(top: 15, left: 10, right: 10),
      child: Container(
        height: 1.5,
        color: filled ? success.withValues(alpha: .55) : line2,
      ),
    ),
  );

  /// Two columns split by a rule rather than two cards, so the password and the
  /// phone steps read as one thing done in two places.
  Widget remoteColumns() => LayoutBuilder(
    builder: (context, constraints) {
      if (constraints.maxWidth < 620) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            remotePasswordColumn(),
            gap(26),
            remoteConnectColumn(),
          ],
        );
      }
      return IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: remotePasswordColumn()),
            Container(
              width: 1,
              margin: const EdgeInsets.symmetric(horizontal: 30),
              color: line2,
            ),
            Expanded(child: remoteConnectColumn()),
          ],
        ),
      );
    },
  );

  /// One card, two states. The form is the whole card while there is no password
  /// (that is the only thing to do), and one stored-password row with a single
  /// action once there is, so the page never shows fields that would overwrite a
  /// working password by accident.
  Widget remotePasswordColumn() {
    final editing = !remotePasswordSet || changingRemotePassword;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                'Remote password',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
            remotePasswordSet
                ? tag('Set', good: true)
                : tag('Not set', tint: warning),
          ],
        ),
        gap(8),
        if (editing) ...[
          Text(
            remotePasswordSet
                ? 'Setting a new one ends any phone session that is open now.'
                : 'Use a separate password, not your $computer login. Your phone '
                      'asks for it on each new connection.',
            style: const TextStyle(fontSize: 13, height: 1.5, color: muted),
          ),
          gap(14),
          TextField(
            key: const Key('remote-password'),
            controller: remotePassword,
            obscureText: !remotePasswordVisible,
            enableSuggestions: false,
            autocorrect: false,
            decoration: InputDecoration(
              labelText: 'Password, at least 12 characters',
              suffixIcon: IconButton(
                key: const Key('remote-password-reveal'),
                tooltip: remotePasswordVisible ? 'Hide' : 'Show',
                iconSize: 19,
                color: muted,
                onPressed: () => changeView(
                  () => remotePasswordVisible = !remotePasswordVisible,
                ),
                icon: Icon(
                  remotePasswordVisible
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                ),
              ),
            ),
          ),
          gap(8),
          TextField(
            key: const Key('remote-password-confirm'),
            controller: remoteConfirm,
            obscureText: !remoteConfirmVisible,
            enableSuggestions: false,
            autocorrect: false,
            decoration: InputDecoration(
              labelText: 'Confirm password',
              suffixIcon: IconButton(
                key: const Key('remote-confirm-reveal'),
                tooltip: remoteConfirmVisible ? 'Hide' : 'Show',
                iconSize: 19,
                color: muted,
                onPressed: () => changeView(
                  () => remoteConfirmVisible = !remoteConfirmVisible,
                ),
                icon: Icon(
                  remoteConfirmVisible
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                ),
              ),
            ),
            onSubmitted: (_) => saveRemotePassword(),
          ),
          gap(14),
          Wrap(
            spacing: 8,
            children: [
              button(
                remotePasswordSet ? 'Save new password' : 'Set password',
                saveRemotePassword,
                enabled: !remoteBusy,
                primary: true,
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
          // The panel-wide banner sits above the stepper, out of view by the
          // time the owner reaches this button, so a refusal also shows here.
          if (remoteError != null) ...[
            gap(10),
            Text(
              remoteError!,
              key: const Key('remote-password-error'),
              style: const TextStyle(fontSize: 12.5, color: Color(0xffff9d92)),
            ),
          ],
        ] else ...[
          remotePasswordStoredRow(),
          gap(10),
          Text(
            'Changing it ends any phone session that is open now.',
            style: const TextStyle(fontSize: 13, height: 1.5, color: muted),
          ),
          gap(14),
          button(
            'Change password',
            () => changeView(() => changingRemotePassword = true),
            compact: true,
            key: const Key('remote-password-change'),
          ),
        ],
      ],
    );
  }

  /// The stored password, as the only thing about it that can be shown: a lock
  /// and a fixed mask. The backend keeps a salt and a scrypt hash and does not
  /// store the length, so this is a fixed twelve dots and never a character
  /// count, and the row says plainly where the password lives.
  ///
  /// A [Wrap], not a [Row]: this column is about 277 px wide in the owner's
  /// window and the label carries the computer's name, so a long name drops the
  /// label onto its own line instead of overflowing the row.
  Widget remotePasswordStoredRow() => Container(
    width: double.infinity,
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
    decoration: BoxDecoration(
      color: toneCharcoal,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: line2),
    ),
    child: Wrap(
      spacing: 12,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.lock_outline_rounded, size: 18, color: muted),
            const SizedBox(width: 12),
            const Text(
              '••••••••••••',
              maxLines: 1,
              style: TextStyle(fontSize: 14, letterSpacing: 2, color: ink),
            ),
          ],
        ),
        small('Stored on this $computer'),
      ],
    ),
  );

  Widget remoteConnectColumn() {
    final state = remoteLink['state'] ?? 'idle';
    final active = ['offered', 'connecting', 'connected'].contains(state);
    final reason = remoteLink['reason'] as String?;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Connect from your phone',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
        gap(8),
        Text(
          remotePasswordSet
              ? 'Send the request from your connected chat:'
              : 'Once your password is set:',
          style: const TextStyle(fontSize: 13, height: 1.5, color: muted),
        ),
        gap(16),
        remoteStep(
          1,
          'Send "control my screen" to FarFromDesk in $channelName.',
        ),
        remoteStep(2, 'Open the link it sends on your phone.'),
        remoteStep(3, 'Send back the code the phone page shows.'),
        remoteStep(4, 'Enter your remote password on the phone.'),
        if (state == 'offered') ...[
          gap(10),
          small(
            'Waiting for the code from your phone. The link expires after 5 minutes.',
          ),
        ],
        if (state == 'ended' && reason != null) ...[
          gap(10),
          small('Last session ended. ${remoteMessage(reason)}'),
        ],
        if (active) ...[
          gap(14),
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
    padding: const EdgeInsets.only(bottom: 10),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 22,
          height: 22,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: hairline),
          ),
          child: Text('$n', style: const TextStyle(fontSize: 11.5, color: muted)),
        ),
        const SizedBox(width: 12),
        Expanded(child: Text(text, style: const TextStyle(fontSize: 13))),
      ],
    ),
  );
}
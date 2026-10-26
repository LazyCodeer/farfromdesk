part of 'app.dart';

// Layout is ported from the build-41 SwiftUI views. Only OS wording and verified
// integration availability differ; component geometry and navigation are shared.
extension _BridgeScreens on _DeskState {
  bool get hasChannelChoice => status['channelChosen'] != false;
  bool get usingTelegram => status['controlChannel'] == 'telegram';
  String get channelName => usingTelegram ? 'Telegram' : 'WhatsApp';
  bool get connected =>
      status[usingTelegram ? 'telegram' : 'whatsapp']?['status'] == 'connected';
  String get computer => api.platform == 'macos'
      ? 'Mac'
      : api.platform == 'windows'
      ? 'PC'
      : 'computer';
  Map? get selectedPlatform => platforms
      .cast<Map>()
      .where((p) => '${p['provider']}:${p['executionMode']}' == platform)
      .firstOrNull;
  String get platformName =>
      '${platform.startsWith('claude') ? 'Claude' : 'Codex'} ${platform.endsWith('desktop') ? 'Desktop' : 'CLI'}';
  String get defaultCoordinatorName => 'FarFromDesk Orbit · $platformName';

  void selectCoordinatorPlatform(String value) {
    platform = value;
    if (!coordinatorNameEdited) customName.text = defaultCoordinatorName;
  }

  void editSetup(VoidCallback change) {
    changeView(change);
    modalUpdate?.call(() {});
  }

  Widget small(String text) => Builder(
    builder: (c) => Text(
      text,
      style: TextStyle(
        fontSize: 11,
        color: onLight(c) ? toneMuted : muted,
        height: 1.5,
      ),
    ),
  );
  Widget gap([double size = 18]) => SizedBox(height: size);
  Widget buildDesk(BuildContext context) {
    final titles = ['Home', 'Activity', 'Settings'];
    final pending = (status['pendingJobs'] ?? []).length;
    final count = pending + (status['approvals'] ?? []).length;
    return Scaffold(
      body: SafeArea(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            sidebar(titles, count),
            Expanded(
              child: Column(
                children: [
                  topBar(titles),
                  if (api.preview)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 32,
                        vertical: 7,
                      ),
                      child: small(
                        'Design preview · sample data · no account is connected',
                      ),
                    ),
                  if (error != null || actionError != null)
                    Container(
                      margin: const EdgeInsets.fromLTRB(32, 16, 32, 0),
                      padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
                      decoration: BoxDecoration(
                        color: sand,
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.error_outline,
                            color: warning,
                            size: 19,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: SelectableText(error ?? actionError!),
                          ),
                          IconButton(
                            tooltip: 'Dismiss error',
                            onPressed: () => changeView(() {
                              error = null;
                              actionError = null;
                            }),
                            icon: const Icon(Icons.close, size: 16),
                          ),
                        ],
                      ),
                    ),
                  Expanded(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(32, 24, 32, 48),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (!ready) ...[
                            if (error == null)
                              const Center(child: CircularProgressIndicator())
                            else
                              button('Try again', boot),
                          ] else if (section == 0)
                            ...homeScreen()
                          else if (section == 1)
                            ...activityScreen()
                          else
                            ...settingsScreen(),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget sidebar(List<String> titles, int count) => Container(
    key: const ValueKey('navigation-rail'),
    width: 216,
    padding: const EdgeInsets.fromLTRB(12, 0, 12, 14),
    decoration: const BoxDecoration(
      border: Border(right: BorderSide(color: hairline)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 64,
          child: Row(
            children: [
              const SizedBox(width: 8),
              Image.asset(
                'assets/ffd-icon.png',
                key: const ValueKey('header-logo'),
                width: 28,
                height: 28,
              ),
              const SizedBox(width: 10),
              const Text(
                'FarFromDesk',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -.2,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        for (var i = 0; i < 3; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Tooltip(
              message: titles[i],
              child: Material(
                color: section == i ? panelColor : Colors.transparent,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                  side: section == i
                      ? const BorderSide(color: line2)
                      : BorderSide.none,
                ),
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  hoverColor: hover,
                  onTap: () => go(i),
                  child: SizedBox(
                    height: 40,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Row(
                        children: [
                          Icon(
                            [
                              Icons.home_outlined,
                              Icons.show_chart_rounded,
                              Icons.settings_outlined,
                            ][i],
                            size: 18,
                            color: section == i ? accent : muted,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              titles[i],
                              style: TextStyle(
                                fontSize: 14,
                                fontWeight: section == i
                                    ? FontWeight.w600
                                    : FontWeight.w500,
                                color: section == i ? ink : muted,
                              ),
                            ),
                          ),
                          if (i == 1 && count > 0)
                            Container(
                              constraints: const BoxConstraints(minWidth: 20),
                              height: 20,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                              ),
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: warning,
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                '$count',
                                style: const TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w700,
                                  color: toneInk,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        const Spacer(),
        if (update.release != null) ...[
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: panelColor,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: line2),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Update available',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
                ),
                gap(6),
                Text(
                  'Version ${update.release!.version} installs after your current work finishes.',
                  style: const TextStyle(fontSize: 11.5, color: muted),
                ),
                gap(10),
                FilledButton(
                  onPressed: showUpdate,
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 34)),
                  child: const Text('Update now'),
                ),
              ],
            ),
          ),
          gap(10),
        ],
        Container(
          padding: const EdgeInsets.fromLTRB(6, 10, 6, 0),
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: hairline)),
          ),
          child: Row(
            children: [
              InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: () => act(
                  () => api.openReleasePage(
                    Uri.parse('https://github.com/LazyCodeer/farfromdesk'),
                  ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Image.asset(
                      'assets/logo-github.png',
                      width: 16,
                      height: 16,
                    ),
                    const SizedBox(width: 8),
                    const Text(
                      'GitHub',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: muted,
                      ),
                    ),
                  ],
                ),
              ),
              const Spacer(),
              const Text(
                'v$installedVersion',
                style: TextStyle(fontSize: 12, color: muted),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  Widget topBar(List<String> titles) => Container(
    constraints: const BoxConstraints(minHeight: 64),
    padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 10),
    decoration: const BoxDecoration(
      border: Border(bottom: BorderSide(color: hairline)),
    ),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                titles[section],
                style: Theme.of(context).textTheme.headlineLarge,
              ),
              const SizedBox(height: 2),
              Text(
                [
                  'Your messaging connection and coding assistant.',
                  'See which session answered and what needs your attention.',
                  'Decide when FarFromDesk runs and how this $computer stays available.',
                ][section],
                style: const TextStyle(fontSize: 12, color: muted),
              ),
            ],
          ),
        ),
        if (ready && hasChannelChoice) ...[
          if (connected) ...[
            tag('Connected', good: true),
            const SizedBox(width: 12),
            spinButton('Refresh connection', 'Refreshing…', refresh),
          ] else ...[
            tag('Not connected', tint: warning),
            const SizedBox(width: 12),
            button(
              usingTelegram
                  ? 'Set up Telegram'
                  : status['whatsapp']?['qr'] != null
                  ? 'Check connection'
                  : 'Show QR code',
              usingTelegram
                  ? () async {
                      go(0);
                    }
                  : connectPhone,
              primary: true,
            ),
          ],
        ],
      ],
    ),
  );

  /// A button that shows a short spinner while [run] works, so the owner
  /// can see something happened even when the answer comes back at once.
  Widget spinButton(
    String label,
    String working,
    Future<void> Function() run, {
    bool primary = false,
  }) {
    Future<void> go() async {
      changeView(() => refreshing = true);
      await Future.wait([
        run(),
        Future<void>.delayed(const Duration(milliseconds: 900)),
      ]);
      if (mounted) changeView(() => refreshing = false);
    }

    final child = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (refreshing) ...[
          SizedBox(
            width: 13,
            height: 13,
            child: spinner(primary ? onAction : ink),
          ),
          const SizedBox(width: 8),
        ],
        Text(refreshing ? working : label),
      ],
    );
    final onPressed = busy || refreshing ? null : go;
    return primary
        ? FilledButton(onPressed: onPressed, child: child)
        : OutlinedButton(onPressed: onPressed, child: child);
  }

  Future<void> connectPhone() async {
    if (preferences['backgroundEnabled'] != true) {
      if (!await confirm(
        'Allow background access and connect WhatsApp?',
        'The bridge will run on this $computer so WhatsApp can reach your sessions while this window is closed. You can pause it in Settings. Keeping your $computer awake is optional and remains off.',
        actionLabel: 'Allow and connect',
      )) {
        return;
      }
      await act(() async {
        await api.post('/api/preferences', {
          'backgroundEnabled': true,
          'keepAwake': false,
        });
        await api.post('/api/connect', {});
      });
    } else if (status['whatsapp']?['qr'] != null) {
      await refresh();
    } else {
      await post('/api/connect');
    }
  }

  List<Widget> homeScreen() {
    final wa = status['whatsapp'] ?? {};
    if (!hasChannelChoice) {
      return [if (api.preview) previewFlows(), messagingEmptyState()];
    }
    Widget left(bool stretch) => usingTelegram
        ? telegramCard()
        : connected
        ? Column(
            children: [
              whatsappCard(wa),
              if (stretch)
                Expanded(child: destinationCard())
              else
                destinationCard(),
            ],
          )
        : pairingCard(wa);
    return [
      if (api.preview) previewFlows(),
      if (!connected)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Align(
            alignment: Alignment.centerLeft,
            child: button(
              'Choose another app',
              switchMessagingApp,
              compact: true,
            ),
          ),
        ),
      LayoutBuilder(
        builder: (context, box) => box.maxWidth >= 860
            ? IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(child: left(true)),
                    const SizedBox(width: 12),
                    Expanded(child: codingPlatformsCard()),
                  ],
                ),
              )
            : Column(children: [left(false), codingPlatformsCard()]),
      ),
      if (!usingTelegram && wa['error'] != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(wa['error'], style: const TextStyle(color: warning)),
        ),
      if (!connected)
        nextSteps()
      else ...[
        card(coordinatorSummary()),
        voiceCard(),
      ],
    ];
  }

  Widget previewFlows() => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Row(
      children: [
        const Expanded(
          child: Text(
            'Preview a connection flow',
            style: TextStyle(fontSize: 12, color: muted),
          ),
        ),
        DropdownButton<String>(
          key: ValueKey(status['previewFlow']),
          value: (status['previewFlow'] ?? 'empty') as String,
          items: const [
            DropdownMenuItem(
              value: 'empty',
              child: Text('Empty · choose an app'),
            ),
            DropdownMenuItem(
              value: 'whatsapp-setup',
              child: Text('WhatsApp · not connected'),
            ),
            DropdownMenuItem(
              value: 'whatsapp-qr',
              child: Text('WhatsApp · scan QR'),
            ),
            DropdownMenuItem(
              value: 'whatsapp-connected',
              child: Text('WhatsApp · connected'),
            ),
            DropdownMenuItem(
              value: 'telegram',
              child: Text('Telegram · bot setup'),
            ),
            DropdownMenuItem(
              value: 'telegram-pairing',
              child: Text('Telegram · waiting for Start'),
            ),
            DropdownMenuItem(
              value: 'telegram-confirm',
              child: Text('Telegram · confirm account'),
            ),
            DropdownMenuItem(
              value: 'telegram-connected',
              child: Text('Telegram · connected'),
            ),
            DropdownMenuItem(
              value: 'telegram-expired',
              child: Text('Telegram · link expired'),
            ),
            DropdownMenuItem(
              value: 'telegram-error',
              child: Text('Telegram · connection error'),
            ),
          ],
          onChanged: (value) async {
            if (value != null) {
              await api.previewFlow(value);
              await refresh();
            }
          },
        ),
      ],
    ),
  );

  Future<void> chooseMessagingApp(String next) =>
      post('/api/control-channel', {'channel': next});

  Future<void> disconnectMessagingApp() async {
    if (!await confirm(
      'Disconnect $channelName?',
      usingTelegram
          ? 'Your bot will stop receiving requests and its saved token will be removed from this computer. Your coordinators and history stay saved.'
          : 'WhatsApp will be logged out on this computer. Scan a new QR code to reconnect. Your coordinators and history stay saved.',
      actionLabel: 'Disconnect',
    )) {
      return;
    }
    await act(() async {
      await api.post('/api/control-channel/disconnect', {
        'expectedChannel': usingTelegram ? 'telegram' : 'whatsapp',
        'confirmed': true,
      });
      telegramToken.clear();
      groupsLoaded = false;
    });
  }

  Widget messagingSettingsHint() => Wrap(
    crossAxisAlignment: WrapCrossAlignment.center,
    spacing: 4,
    children: [
      small('Want to receive messages in another app?'),
      TextButton(
        onPressed: () => go(2),
        child: const Text('Messaging settings'),
      ),
    ],
  );

  Widget messagingAppSettings() => panel(
    'Messaging app',
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        small(
          'Choose where you send requests and receive replies. Changing apps disconnects the current one first.',
        ),
        gap(12),
        for (final entry in [
          ('whatsapp', 'WhatsApp'),
          ('telegram', 'Telegram'),
        ])
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Row(
              children: [
                logoTile(entry.$1, size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        entry.$2,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      small(
                        hasChannelChoice &&
                                (usingTelegram ? 'telegram' : 'whatsapp') ==
                                    entry.$1
                            ? connected
                                  ? 'Connected · receiving your requests'
                                  : 'Selected · not connected'
                            : 'Not connected',
                      ),
                    ],
                  ),
                ),
                if (hasChannelChoice &&
                    (usingTelegram ? 'telegram' : 'whatsapp') == entry.$1)
                  connected
                      ? tag('Current', good: true)
                      : button('Connect', () => go(0), compact: true)
                else
                  button('Use ${entry.$2}', () async {
                    if (!hasChannelChoice) {
                      await chooseMessagingApp(entry.$1);
                      if (mounted && actionError == null) go(0);
                    } else {
                      await switchMessagingApp();
                    }
                  }, compact: true),
              ],
            ),
          ),
      ],
    ),
  );

  Future<void> switchMessagingApp() async {
    final current = usingTelegram ? 'telegram' : 'whatsapp';
    final next = usingTelegram ? 'whatsapp' : 'telegram';
    final name = usingTelegram ? 'WhatsApp' : 'Telegram';
    final info = status['channelSwitch'];
    final hasTelegramSetup =
        (status['telegram']?['configured'] == true) ||
        (status['telegram']?['status'] == 'connecting');
    final hasWhatsAppSetup = connected || (status['whatsapp']?['qr'] != null);
    final needsConfirmation =
        (info?['requiresConfirmation'] as bool?) ??
        (usingTelegram ? hasTelegramSetup : hasWhatsAppSetup);
    final setup = info?['state'] == 'setup';
    final saved = info?['state'] == 'saved';
    if (needsConfirmation) {
      final consequence = usingTelegram
          ? setup
                ? 'Your unfinished Telegram setup will be cancelled and any saved bot token removed from this computer.'
                : saved
                ? 'Your saved Telegram bot connection and token will be removed from this computer.'
                : 'Your Telegram bot will be disconnected and its saved token removed from this computer.'
          : setup
          ? 'Your unfinished WhatsApp pairing will be cancelled. You can start it again later.'
          : 'WhatsApp will be logged out on this computer. You’ll need to scan a new QR code if you switch back.';
      if (!await confirm(
        'Switch to $name?',
        '$consequence\n\nNext, you’ll connect $name. Your coordinators and history stay saved. Replies waiting for the old app stay there; they won’t move to $name.',
        actionLabel: setup
            ? 'Cancel setup and switch'
            : 'Disconnect and switch',
      )) {
        return;
      }
    }
    await act(() async {
      await api.post('/api/control-channel', {
        'channel': next,
        'expectedChannel': current,
        if (needsConfirmation) 'confirmed': true,
      });
      telegramToken.clear();
      groupsLoaded = false;
      if (mounted) go(0);
    });
  }

  Widget messagingEmptyState() {
    Widget option(String id, String name, String detail, String action) =>
        Material(
          color: surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
            side: const BorderSide(color: line2),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: busy ? null : () => chooseMessagingApp(id),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  logoTile(id),
                  gap(20),
                  Text(
                    name,
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  gap(8),
                  Text(
                    detail,
                    style: const TextStyle(
                      color: muted,
                      fontSize: 13,
                      height: 1.6,
                    ),
                  ),
                  gap(24),
                  Row(
                    children: [
                      Text(
                        action,
                        style: const TextStyle(
                          fontWeight: FontWeight.w600,
                          color: accent,
                        ),
                      ),
                      const SizedBox(width: 8),
                      const Icon(Icons.arrow_forward, size: 17, color: accent),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
    return card(
      Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            tag('Let’s get connected'),
            gap(20),
            const Text(
              'Your coding sessions,\none message away.',
              style: TextStyle(
                fontSize: 30,
                height: 1.2,
                fontWeight: FontWeight.w600,
              ),
            ),
            gap(12),
            const Text(
              'Choose the app you want to use from your phone.\nConnect it once, then ask for updates or get work started.',
              style: TextStyle(color: muted, height: 1.6),
            ),
            gap(28),
            LayoutBuilder(
              builder: (context, box) {
                final options = [
                  option(
                    'whatsapp',
                    'WhatsApp',
                    'Use your own account. Scan a QR code and send requests in your private chat.',
                    'Continue with WhatsApp',
                  ),
                  option(
                    'telegram',
                    'Telegram',
                    'Use a private bot. Add its token and confirm the account that can control it.',
                    'Continue with Telegram',
                  ),
                ];
                return box.maxWidth >= 640
                    ? IntrinsicHeight(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Expanded(child: options[0]),
                            const SizedBox(width: 16),
                            Expanded(child: options[1]),
                          ],
                        ),
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [options[0], gap(16), options[1]],
                      );
              },
            ),
            gap(20),
            small(
              'Change your messaging app later in Settings. Your coding coordinators stay with you.',
            ),
          ],
        ),
      ),
    );
  }

  Widget telegramCard() {
    final tg = Map<String, dynamic>.from(status['telegram'] ?? {});
    final candidate = tg['candidate'] as Map?;
    final link = tg['pairingUrl'] as String?;
    final waiting = tg['status'] == 'pairing';
    return card(
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              logoTile('telegram', size: 42),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      connected ? '@${tg['username']}' : 'Connect Telegram',
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      connected
                          ? 'Private bot · only your confirmed account can control it'
                          : 'Your own bot, connected directly to this computer.',
                      style: const TextStyle(color: muted, fontSize: 12),
                    ),
                  ],
                ),
              ),
              if (connected || tg['configured'] == true)
                button('Disconnect', disconnectMessagingApp, compact: true),
            ],
          ),
          gap(20),
          if (tg['status'] == 'disconnected') ...[
            tag('Not connected'),
            gap(12),
          ],
          if (connected) ...[
            tag('Connected', good: true),
            gap(12),
            Text(
              'Linked to ${tg['ownerName'] ?? 'your account'} · ID ${tg['ownerId'] ?? ''}',
              style: const TextStyle(fontSize: 12, color: muted),
            ),
            gap(16),
            const Text(
              'Ask naturally',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            gap(6),
            const Text(
              '“Show my recent sessions”\n“Tell me what I worked on today”\n“Claude, check the website task”',
              style: TextStyle(fontSize: 13, height: 1.7),
            ),
            gap(12),
            small(
              'Replies return to the chat that requested the work. Telegram bots use cloud chats, not end-to-end encrypted Secret Chats.',
            ),
            gap(12),
            messagingSettingsHint(),
          ] else if (candidate != null) ...[
            const Text(
              'Confirm your Telegram account',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            gap(8),
            Text('${candidate['name']} · ID ${candidate['id']}'),
            gap(8),
            small(
              'Only confirm if this is the account you just used to open the pairing link.',
            ),
            gap(16),
            button(
              'Confirm this account',
              () => post('/api/telegram/confirm', {'userId': candidate['id']}),
              primary: true,
            ),
          ] else if (waiting && link != null) ...[
            const Text(
              'Open your private pairing link',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            gap(8),
            small(
              'Open it in Telegram and tap Start. Come back here to confirm your account. The link expires after 10 minutes; keep it private.',
            ),
            gap(14),
            Row(
              children: [
                button(
                  'Open Telegram',
                  () => act(() => api.openTelegram(Uri.parse(link))),
                  primary: true,
                ),
                const SizedBox(width: 8),
                button('Copy link', () async {
                  await Clipboard.setData(ClipboardData(text: link));
                }),
              ],
            ),
            gap(16),
            Row(
              children: [
                SizedBox(width: 14, height: 14, child: spinner(ink)),
                const SizedBox(width: 10),
                const Text(
                  'Waiting for you in Telegram',
                  style: TextStyle(fontSize: 12, color: muted),
                ),
              ],
            ),
          ] else ...[
            stepRow(
              'Create a bot',
              detail: 'Open @BotFather in Telegram, choose /newbot, and copy its bot token.',
              state: 'pending',
            ),
            button(
              'Open BotFather',
              () => act(
                () => api.openTelegram(Uri.parse('https://t.me/BotFather')),
              ),
            ),
            gap(16),
            TextField(
              controller: telegramToken,
              obscureText: true,
              enableSuggestions: false,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Bot token',
                hintText: 'Paste the token from BotFather',
              ),
            ),
            gap(8),
            small(
              'Saved only on this computer with restricted file permissions. Never paste it into a coding chat.',
            ),
            gap(16),
            button(tg['configured'] == true ? 'Reconnect Telegram' : 'Connect bot', () async {
              if (preferences['backgroundEnabled'] != true) {
                if (!await confirm(
                  'Allow background access and connect Telegram?',
                  'FarFromDesk will run on this $computer so Telegram can reach your sessions while this window is closed. Keeping your $computer awake stays off.',
                  actionLabel: 'Allow and connect',
                )) {
                  return;
                }
                await post('/api/preferences', {
                  'backgroundEnabled': true,
                  'keepAwake': false,
                });
              }
              await act(() async {
                await api.post('/api/telegram/connect', {
                  'token': telegramToken.text.trim(),
                });
                telegramToken.clear();
              });
            }, primary: true),
          ],
          if (tg['error'] != null) ...[
            gap(14),
            Text(
              tg['error'],
              style: const TextStyle(color: warning, fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }

  Widget whatsappCard(Map wa) => card(
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            logoTile('whatsapp'),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    wa['phoneNumber'] ?? 'Your WhatsApp account',
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Text(
                    'Linked WhatsApp account',
                    style: TextStyle(color: onPineMuted),
                  ),
                ],
              ),
            ),
            button('Disconnect', disconnectMessagingApp, compact: true),
          ],
        ),
        gap(16),
        const Text(
          'Only this account can control FarFromDesk.',
          style: TextStyle(color: onPineMuted),
        ),
        gap(12),
        messagingSettingsHint(),
      ],
    ),
    tone: tonePine,
  );

  Widget pairingCard(Map wa) => card(
    tone: tonePine,
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            logoTile('whatsapp'),
            const SizedBox(width: 14),
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Connect your WhatsApp',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                  ),
                  Text(
                    'A one-time setup. Your phone stays the only account that can control FarFromDesk.',
                    style: TextStyle(color: onPineMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
        gap(20),
        Center(
          child: wa['qr'] is String
              ? Container(
                  width: 220,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Column(
                    children: [
                      Image.memory(
                        base64Decode((wa['qr'] as String).split(',').last),
                        width: 160,
                        height: 160,
                        semanticLabel: 'WhatsApp pairing QR code',
                      ),
                      gap(10),
                      const Text(
                        'Scan with WhatsApp',
                        style: TextStyle(
                          fontSize: 11,
                          color: Color(0xff444444),
                        ),
                      ),
                    ],
                  ),
                )
              : Container(
                  width: 220,
                  height: 220,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: .2),
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: const Color(0x29f4f1ea)),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.qr_code_2, size: 64, color: accent),
                      gap(12),
                      if (wa['status'] == 'connecting')
                        const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      else
                        button('Show QR code', connectPhone, primary: true),
                      gap(12),
                      Text(
                        wa['status'] == 'connecting'
                            ? 'Preparing your connection…'
                            : preferences['backgroundEnabled'] != true
                            ? 'Asks for background access first. No sleep settings change.'
                            : 'Open WhatsApp, then Linked devices, then Link a device.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 11,
                          height: 1.4,
                          color: onPineMuted,
                        ),
                      ),
                    ],
                  ),
                ),
        ),
      ],
    ),
  );

  Widget nextSteps() {
    Widget step(String n, String title, String detail) => Expanded(
      child: CustomPaint(
        painter: _DashedBorder(),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 24,
                height: 24,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: surface,
                  shape: BoxShape.circle,
                  border: Border.all(color: line2),
                ),
                child: Text(
                  n,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              gap(10),
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              gap(4),
              small(detail),
            ],
          ),
        ),
      ),
    );
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          step(
            '1',
            'Connect $channelName',
            usingTelegram
                ? 'Link your bot and confirm your Telegram account.'
                : 'Scan the QR code above with your phone.',
          ),
          const SizedBox(width: 12),
          step(
            '2',
            'Set up a coordinator',
            'Pick Claude or Codex to handle your messages.',
          ),
          const SizedBox(width: 12),
          step(
            '3',
            usingTelegram ? 'Message your bot' : 'Message yourself',
            'Ask for an update or start work from your phone.',
          ),
        ],
      ),
    );
  }

  Widget voiceCard() {
    final v = Map<String, dynamic>.from(status['voice'] ?? {});
    final cloud = v['engine'] == 'deepgram' || v['engine'] == 'assemblyai';
    final downloading = v['download']?['state'] == 'downloading';
    final title = v['ready'] == true
        ? 'Voice notes ready'
        : downloading
        ? 'Downloading speech model'
        : 'Set up voice notes';
    final detail = v['ready'] == true
        ? cloud
              ? 'Send a voice note in your connected chat. Transcribed by ${voiceName(v['engine'])} with your key ending ${v['keyHint']}.'
              : 'Send a voice note in your connected chat. Audio is processed locally on this $computer.'
        : downloading
        ? 'Voice notes work as soon as it finishes.'
        : 'Voice notes can\'t be read yet. Choose how they become text.';
    return card(
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: surface,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(
                  v['ready'] == true ? Icons.graphic_eq : Icons.mic_none,
                  color: v['ready'] == true || downloading ? accent : warning,
                  size: 20,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: Theme.of(context).textTheme.titleLarge),
                    gap(4),
                    Text(
                      detail,
                      style: const TextStyle(fontSize: 12, color: muted),
                    ),
                  ],
                ),
              ),
              if (v['ready'] == true && cloud)
                button('Change', () => go(2), compact: true)
              else if (v['ready'] != true && !downloading)
                tag('Not set up', tint: warning),
            ],
          ),
          if (downloading) ...[gap(14), voiceDownload()],
          if (v['ready'] != true && !downloading) ...[gap(14), voiceSetup()],
        ],
      ),
    );
  }

  String voiceName(Object? engine) =>
      engine == 'assemblyai' ? 'AssemblyAI' : 'Deepgram';

  /// Local model or the owner's own API key; shared by Home and Settings.
  Widget voiceSetup() {
    final v = Map<String, dynamic>.from(status['voice'] ?? {});
    final engine = v['engine'] ?? 'local';
    final cloud = engine == 'deepgram' || engine == 'assemblyai';
    final path = voicePathChoice ?? (cloud ? 'api' : 'local');
    final provider = voiceProviderChoice ?? (cloud ? engine : 'deepgram');
    final name = voiceName(provider);
    final connected =
        cloud &&
        engine == provider &&
        v['keyHint'] != null &&
        !replacingVoiceKey;
    Widget choice(
      String value,
      String title,
      String detail,
      bool selected,
      VoidCallback onTap,
    ) => Expanded(
      child: Semantics(
        inMutuallyExclusiveGroup: true,
        checked: selected,
        child: Material(
          color: selected ? const Color(0x1a86c9ad) : const Color(0x0af4f1ea),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: BorderSide(
              color: selected ? accent : hairline,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: InkWell(
            customBorder: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
            onTap: busy ? null : onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Text(
                          detail,
                          style: const TextStyle(fontSize: 11.5, color: muted),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    width: 16,
                    height: 16,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: selected ? accent : null,
                      border: selected
                          ? null
                          : Border.all(color: ink.withValues(alpha: .3)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    Widget box(List<Widget> children) => Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0x0af4f1ea),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    );
    Widget stepLine(int n, Widget text) => Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 20,
            height: 20,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: Color(0x2486c9ad),
              shape: BoxShape.circle,
            ),
            child: Text(
              '$n',
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: accent,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(child: text),
        ],
      ),
    );
    final signup = provider == 'assemblyai'
        ? Uri.parse('https://www.assemblyai.com/dashboard/')
        : Uri.parse('https://console.deepgram.com/');
    void pick(String? p, String? prov) => changeView(() {
      voicePathChoice = p ?? voicePathChoice;
      voiceProviderChoice = prov ?? voiceProviderChoice;
      replacingVoiceKey = false;
    });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            choice(
              'local',
              'On this $computer',
              'Free and private. One-time 148 MB download.',
              path == 'local',
              () => pick('local', null),
            ),
            const SizedBox(width: 12),
            choice(
              'api',
              'Use an API key',
              'No download. Free credits from Deepgram or AssemblyAI.',
              path == 'api',
              () => pick('api', null),
            ),
          ],
        ),
        if (path == 'local') ...[
          if (v['localReady'] == true)
            box([
              Row(
                children: [
                  Expanded(
                    child: settingText(
                      'Speech model',
                      'Runs on this $computer only. Audio never leaves it.',
                    ),
                  ),
                  if (cloud)
                    button(
                      'Use this $computer',
                      () => post('/api/voice-engine', {'engine': 'local'}),
                      compact: true,
                      primary: true,
                    )
                  else
                    tag('Ready', good: true),
                ],
              ),
            ])
          else if (v['download'] != null)
            box([
              small(
                'Needs 160 MB of free space. You can keep using the app while it downloads.',
              ),
              gap(10),
              voiceDownload(),
            ])
          else
            box([
              small(
                'This build has no bundled speech tools. Choose your own in Settings, or use an API key.',
              ),
            ]),
          if (cloud && v['localReady'] != true && v['download'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: small(
                'Voice notes keep using ${voiceName(engine)} until you switch.',
              ),
            ),
        ] else ...[
          box([
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.info_outline, size: 16, color: muted),
                const SizedBox(width: 10),
                const Expanded(
                  child: Text(
                    'Both platforms give new accounts free credit: Deepgram \$200 and AssemblyAI \$50. No credit card is needed, and that is enough for years of voice notes. Both understand English, Hindi and mixed speech. FarFromDesk isn\'t affiliated with either; this is only for your information.',
                    style: TextStyle(fontSize: 12.5, color: muted),
                  ),
                ),
              ],
            ),
          ]),
          gap(12),
          Row(
            children: [
              choice(
                'deepgram',
                'Deepgram',
                '\$200 free credit',
                provider == 'deepgram',
                () => pick(null, 'deepgram'),
              ),
              const SizedBox(width: 12),
              choice(
                'assemblyai',
                'AssemblyAI',
                '\$50 free credit',
                provider == 'assemblyai',
                () => pick(null, 'assemblyai'),
              ),
            ],
          ),
          if (connected)
            box([
              Row(
                children: [
                  Expanded(
                    child: settingText(
                      '$name key ending ${v['keyHint']}',
                      'Voice notes are sent to $name to be transcribed.',
                    ),
                  ),
                  tag('Connected', good: true),
                ],
              ),
              gap(12),
              Row(
                children: [
                  Expanded(
                    child: settingText(
                      'Use this $computer if $name fails',
                      v['localReady'] == true
                          ? 'Falls back to the speech model when the key or network fails.'
                          : 'Works once the speech model is downloaded under On this $computer.',
                    ),
                  ),
                  Switch(
                    value: v['fallback'] != false,
                    onChanged: busy
                        ? null
                        : (on) => post('/api/voice-engine', {'fallback': on}),
                  ),
                ],
              ),
              gap(8),
              Wrap(
                spacing: 8,
                children: [
                  button(
                    'Replace key',
                    () => changeView(() => replacingVoiceKey = true),
                    compact: true,
                  ),
                  button(
                    'Remove key',
                    () async {
                      if (await confirm(
                        'Remove the $name key?',
                        'Voice notes switch back to this $computer. The key is deleted from FarFromDesk; it stays active in your $name account.',
                        actionLabel: 'Remove key',
                      )) {
                        await post('/api/voice-engine', {'remove': true});
                      }
                    },
                    compact: true,
                    destructive: true,
                  ),
                ],
              ),
            ])
          else ...[
            gap(14),
            stepLine(
              1,
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  const Text('Open ', style: TextStyle(fontSize: 13)),
                  InkWell(
                    onTap: () => act(() => api.openVoiceSignup(signup)),
                    child: Text(
                      signup.host +
                          (provider == 'assemblyai' ? '/dashboard' : ''),
                      style: const TextStyle(
                        fontSize: 13,
                        color: accent,
                        fontWeight: FontWeight.w600,
                        decoration: TextDecoration.underline,
                        decorationColor: accent,
                      ),
                    ),
                  ),
                  const Text(
                    ' and sign up. No credit card needed.',
                    style: TextStyle(fontSize: 13),
                  ),
                ],
              ),
            ),
            stepLine(
              2,
              Text(
                provider == 'assemblyai'
                    ? 'On the dashboard, go to API Keys, create a new API key and copy it.'
                    : 'In the console, go to API Keys, create a new API key and copy it.',
                style: const TextStyle(fontSize: 13),
              ),
            ),
            stepLine(
              3,
              const Text(
                'Paste it below. FarFromDesk tests it and handles the rest.',
                style: TextStyle(fontSize: 13),
              ),
            ),
            gap(4),
            TextField(
              controller: voiceKey,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              onChanged: (_) => changeView(() {}),
              decoration: InputDecoration(
                labelText: '$name API key',
                hintText: 'Paste your key',
                isDense: true,
              ),
            ),
            gap(12),
            Row(
              children: [
                button(
                  'Save and test',
                  () => act(() async {
                    await api.post('/api/voice-engine', {
                      'engine': provider,
                      'key': voiceKey.text,
                    });
                    voiceKey.clear();
                    replacingVoiceKey = false;
                  }),
                  primary: true,
                  compact: true,
                  enabled: voiceKey.text.trim().isNotEmpty,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: small(
                    'Stored only on this $computer, in FarFromDesk\'s private folder. Voice notes are sent to $name to be transcribed.',
                  ),
                ),
              ],
            ),
          ],
        ],
      ],
    );
  }

  Widget settingText(String title, String detail) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        title,
        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
      ),
      Text(detail, style: const TextStyle(fontSize: 11.5, color: muted)),
    ],
  );

  Widget destinationCard() {
    final inGroup = status['destination']?['kind'] == 'group';
    final current = groups
        .where((g) => g['id'] == status['destination']?['jid'])
        .firstOrNull;
    Widget hint(Widget icon, String text) => Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 14),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0x0dffffff),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(padding: const EdgeInsets.only(top: 2), child: icon),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(fontSize: 12.5, color: muted),
            ),
          ),
        ],
      ),
    );
    Widget dot(Color color) => Container(
      width: 8,
      height: 8,
      margin: const EdgeInsets.only(top: 3),
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
    return panel(
      'Where should replies appear?',
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          segmented(
            ['Message yourself', 'Private group'],
            showGroups ? 'Private group' : 'Message yourself',
            (value) {
              if (value == 'Private group') {
                changeView(() => showGroups = true);
                loadGroups();
              } else {
                changeView(() => showGroups = false);
                post('/api/destination');
              }
            },
          ),
          if (!showGroups)
            hint(
              Image.asset(
                'assets/logo-whatsapp.png',
                width: 16,
                height: 16,
                color: whatsappGreen,
              ),
              'Replies go to your Message yourself chat. Nothing else to set up.',
            )
          else ...[
            gap(14),
            if (loadingGroups)
              const LinearProgressIndicator()
            else ...[
              small('Your groups where only you are a member'),
              gap(8),
              if (groups.isEmpty && groupsError == null)
                small('No groups with only you as a member were found.'),
              for (final group in groups) groupOption(group, current),
            ],
            gap(10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                button('+ Create group', createGroup, compact: true),
                button('Refresh groups', loadGroups, compact: true),
              ],
            ),
            groupsError != null
                ? hint(dot(warning), groupsError!)
                : inGroup && current != null
                ? hint(
                    dot(success),
                    'Replies go to ${current['name']}. Only you are in this group.',
                  )
                : hint(
                    dot(warning),
                    'Pick a group where you are the only member. Replies stay in your chat until you choose one.',
                  ),
          ],
        ],
      ),
    );
  }

  /// One reply group as a radio option; choosing it switches replies there.
  Widget groupOption(Map group, Map? current) {
    final selected =
        current?['id'] == group['id'] &&
        status['destination']?['kind'] == 'group';
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Semantics(
        inMutuallyExclusiveGroup: true,
        checked: selected,
        child: Material(
          color: selected ? const Color(0x1a86c9ad) : const Color(0x0af4f1ea),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: BorderSide(
              color: selected ? accent : hairline,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: InkWell(
            customBorder: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
            onTap: busy || selected
                ? null
                : () => post('/api/destination', {'jid': group['id']}),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              child: Row(
                children: [
                  Container(
                    width: 18,
                    height: 18,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected ? accent : ink.withValues(alpha: .3),
                        width: selected ? 5 : 1.5,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          group['name'] ?? 'Group',
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Text(
                          'Only you · checked when used',
                          style: const TextStyle(fontSize: 11.5, color: muted),
                        ),
                      ],
                    ),
                  ),
                  if (selected) tag('In use', good: true),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> loadGroups() async {
    if (loadingGroups || !mounted) return;
    if (!connected) return changeView(() => groupsError = null);
    changeView(() {
      loadingGroups = true;
      groupsError = null;
    });
    try {
      final d = await api.get('/api/group-recover');
      if (mounted) {
        changeView(() {
          groups = List<Map>.from(d['groups'] ?? []);
          groupsLoaded = true;
        });
      }
    } catch (e) {
      if (mounted) {
        changeView(
          () => groupsError =
              'Could not load groups. ${clean(e)} Try Refresh groups.',
        );
      }
    } finally {
      if (mounted) changeView(() => loadingGroups = false);
    }
  }

  Future<void> createGroup() async {
    final name = await ask('Group name', initial: 'FarFromDesk');
    if (name == null || name.isEmpty) return;
    if (await confirm(
      'Create a WhatsApp group?',
      'Create “$name” for your account only. FarFromDesk switches to it after checking membership. An existing bridge group is reused if available.',
    )) {
      await post('/api/group-create', {
        'name': name,
        'operationId': const Uuid().v4(),
      });
      await loadGroups();
    }
  }

  Map? preferredPlatform(String provider) =>
      List<Map>.from(status['platformPreferences'] ?? [])
          .where((p) => p['provider'] == provider)
          .firstOrNull;

  Future<void> checkCodingApps() => act(() async {
    await api.get('/api/master-options?fresh=1');
  });

  Widget codingPlatformsCard() {
    final found = platforms.any((p) => p['available'] == true);
    Widget link(String label, String url) => TextButton(
      onPressed: () => act(() => api.openReleasePage(Uri.parse(url))),
      child: Text(label),
    );
    return panel(
      'Coding platforms',
      trailing: found
          ? spinButton('Check apps', 'Checking…', checkCodingApps)
          : null,
      !found
          ? Padding(
              padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
              child: Column(
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      logoTile('openai', dim: true),
                      const SizedBox(width: 6),
                      logoTile('claude', dim: true),
                    ],
                  ),
                  gap(14),
                  const Text(
                    'No coding apps found',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                  ),
                  gap(6),
                  Text(
                    'FarFromDesk works with Claude Code and Codex on this $computer. Install one, then check again.',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 12, color: muted),
                  ),
                  gap(12),
                  spinButton(
                    'Check again',
                    'Checking…',
                    checkCodingApps,
                    primary: true,
                  ),
                  gap(4),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      link('Get Claude Code', 'https://claude.com/claude-code'),
                      link('Get Codex', 'https://developers.openai.com/codex'),
                    ],
                  ),
                ],
              ),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final provider in ['codex', 'claude'])
                  platformRow(provider),
              ],
            ),
    );
  }

  Widget platformRow(String provider) {
    final options = platforms.where((p) => p['provider'] == provider).toList();
    String mode(String m) =>
        options.any((p) => p['executionMode'] == m && p['available'] == true)
        ? 'available'
        : 'not detected';
    final ready = options.any((p) => p['available'] == true);
    final name = provider == 'codex' ? 'Codex' : 'Claude';
    final chosen = preferredPlatform(provider);
    return Container(
      key: ValueKey('platform-preference-$provider'),
      padding: EdgeInsets.only(top: provider == 'codex' ? 4 : 16, bottom: 16),
      decoration: BoxDecoration(
        border: provider == 'codex'
            ? null
            : const Border(top: BorderSide(color: hairline)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              logoTile(provider == 'codex' ? 'openai' : 'claude'),
              const SizedBox(width: 14),
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
                    small('CLI ${mode('cli')} · Desktop ${mode('desktop')}'),
                  ],
                ),
              ),
              ready ? tag('Ready', good: true) : tag('Not found'),
            ],
          ),
          gap(12),
          dropdown<String>(
            key: ValueKey('platform-runtime-$provider'),
            value: chosen?['executionMode'],
            hint: 'No preference',
            items: [
              for (final option in options)
                DropdownMenuItem<String>(
                  value: option['executionMode'],
                  enabled:
                      option['available'] == true &&
                      option['canCreate'] != false,
                  child: Text(
                    '$name ${option['executionMode'] == 'desktop' ? 'Desktop' : 'CLI'}${option['available'] != true
                        ? ' · not detected'
                        : option['canCreate'] == false
                        ? ' · sign in first'
                        : ''}',
                  ),
                ),
            ],
            onChanged: (value) {
              if (value != null) savePreferredPlatform(provider, value);
            },
          ),
          if (chosen?['connectionLabel'] != null) ...[
            gap(8),
            small(chosen!['connectionLabel']),
          ],
          if (chosen?['executionMode'] == 'desktop')
            for (final option in options.where(
              (p) => p['executionMode'] == 'desktop',
            ))
              if (option['creationReadiness']?['message'] != null) ...[
                gap(8),
                small(option['creationReadiness']['message']),
              ],
        ],
      ),
    );
  }

  Future<void> savePreferredPlatform(String provider, String mode) async {
    final option = platforms.cast<Map>().firstWhere(
      (p) => p['provider'] == provider && p['executionMode'] == mode,
    );
    await post('/api/platform-preference', {
      'provider': provider,
      'executionMode': mode,
      'connectionRevision': option['connection']?['revision'],
    });
  }

  /// Coordinators answer WhatsApp. Older bridges only report one master.
  List<Map> get coordinatorEntries {
    final entries = List<Map>.from(status['coordinators'] ?? []);
    if (entries.isEmpty && status['master'] is Map) {
      return [
        {...status['master'], 'enabled': true, 'isDefault': true},
      ];
    }
    return entries;
  }

  String appName(Map entry) =>
      '${entry['provider'] == 'claude' ? 'Claude' : 'Codex'} · ${entry['executionMode'] == 'desktop' ? 'Desktop' : 'CLI'}';

  Widget coordinatorRow(
    Map entry,
    List<Widget> trailing, {
    String? detail,
  }) => Container(
    margin: const EdgeInsets.only(top: 8),
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    decoration: BoxDecoration(
      color: toneCharcoal,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: hairline),
    ),
    child: Row(
      children: [
        logoTile(entry['provider'] == 'claude' ? 'claude' : 'openai', size: 34),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                entry['name'] ?? 'Coordinator',
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              small(
                '${appName(entry)} · ${detail ?? (entry['enabled'] != true
                        ? 'Forwarding paused'
                        : entry['isDefault'] == true
                        ? 'Default coordinator'
                        : 'Used when a message names ${entry['provider'] == 'claude' ? 'Claude' : 'Codex'}')}',
              ),
              if (entry['error'] != null) small(entry['error'].toString()),
            ],
          ),
        ),
        for (final w in trailing) ...[const SizedBox(width: 8), w],
      ],
    ),
  );

  Widget coordinatorSummary() {
    final entries = coordinatorEntries;
    final background = preferences['backgroundEnabled'] == true;
    if (setupActive) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ...setupOperation(),
          if (status['masterSetup']?['operation']?['status'] ==
              'needs_action') ...[
            gap(10),
            button(
              'Choose another setup',
              () => openManage(adding: true, another: true),
              compact: true,
            ),
          ],
        ],
      );
    }
    if (entries.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Set up a coordinator',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              tag('Not set up'),
            ],
          ),
          gap(4),
          small(
            'It reads your messages and starts or checks coding sessions for you.',
          ),
          ...setupOperation(),
          gap(16),
          masterForm(),
          gap(16),
          masterActions(),
        ],
      );
    }
    final answering = entries
        .where((e) => e['enabled'] == true && e['state'] != 'needs_attention')
        .length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Coordinators',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            small(
              '${entries.length} set up · ${background ? answering : 0} answering',
            ),
          ],
        ),
        if (!background)
          Container(
            margin: const EdgeInsets.only(top: 12),
            padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
            decoration: BoxDecoration(
              color: sand,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    'Running in the background is off, so incoming messages wait until you turn it back on.',
                    style: TextStyle(fontSize: 12.5),
                  ),
                ),
                const SizedBox(width: 12),
                button(
                  'Resume',
                  enableBackground,
                  primary: true,
                  compact: true,
                ),
              ],
            ),
          ),
        gap(4),
        for (final entry in entries)
          coordinatorRow(entry, [
            entry['enabled'] != true
                ? tag('Paused')
                : entry['state'] == 'needs_attention'
                ? tag('Needs attention', tint: warning)
                : background && connected
                ? tag('Ready', good: true)
                : tag('Waiting', tint: warning),
          ]),
        ...setupOperation(),
        gap(14),
        Row(
          children: [
            Expanded(
              child: small(
                'Name a coding platform in your chat, or the default answers general requests.',
              ),
            ),
            const SizedBox(width: 12),
            button('Manage coordinators', openManage, primary: true),
          ],
        ),
      ],
    );
  }

  /// Manage the coordinators that answer the owner's messages.
  Future<void> openManage({
    bool adding = false,
    String? requestedPlatform,
    bool another = false,
  }) async {
    void startAdding([String? requested]) => editSetup(() {
      platform =
          requested ??
          (status['master'] == null
              ? platform
              : '${status['master']['provider']}:${status['master']['executionMode']}');
      coordinatorNameEdited = false;
      customName.text = defaultCoordinatorName;
      setupAction = 'new';
      setupFormRequested = false;
      selectedNativeId = '';
      search.clear();
      visibleSessions = 30;
    });
    addingCoordinator = adding;
    if (adding) startAdding(requestedPlatform);
    if (another) editSetup(() => setupFormRequested = true);
    await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) {
          modalSetter = update;
          modalContext = context;
          final entries = coordinatorEntries;
          final Widget body = setupActive
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ...setupOperation(),
                    if (status['masterSetup']?['operation']?['status'] ==
                        'needs_action') ...[
                      gap(10),
                      button(
                        'Choose another setup',
                        () => editSetup(() => setupFormRequested = true),
                        compact: true,
                      ),
                    ],
                  ],
                )
              : addingCoordinator || entries.isEmpty && setupFormRequested
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (entries.isNotEmpty)
                      TextButton.icon(
                        onPressed: () =>
                            update(() => addingCoordinator = false),
                        icon: const Icon(Icons.arrow_back, size: 16),
                        label: const Text('Back to coordinators'),
                      ),
                    ...setupOperation(),
                    Container(
                      margin: const EdgeInsets.only(top: 12),
                      padding: const EdgeInsets.fromLTRB(18, 18, 18, 16),
                      decoration: BoxDecoration(
                        color: toneCharcoal,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: hairline),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            entries.isEmpty
                                ? 'Set up a coordinator'
                                : 'Add a coordinator',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          gap(4),
                          small(
                            entries.isEmpty
                                ? 'Pick the app that should answer your requests.'
                                : 'Pick the app. Your current coordinators keep working until the new one is ready.',
                          ),
                          gap(16),
                          masterForm(),
                          gap(16),
                          masterActions(),
                        ],
                      ),
                    ),
                  ],
                )
              : entries.isEmpty
              ? emptyBox(
                  'No coordinators yet',
                  'Add one so your messages have someone to answer them.',
                  button('+ Add coordinator', () {
                    startAdding();
                    update(() => addingCoordinator = true);
                  }, primary: true),
                  logos: true,
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final entry in entries)
                      coordinatorRow(entry, [
                        entry['enabled'] != true
                            ? tag('Paused')
                            : entry['state'] == 'needs_attention'
                            ? tag('Needs attention', tint: warning)
                            : tag(
                                entry['isDefault'] == true
                                    ? 'Default'
                                    : 'Connected',
                                good: true,
                              ),
                        if (entry['isDefault'] != true &&
                            entry['enabled'] == true)
                          button(
                            'Make default',
                            () => post('/api/coordinators/default', {
                              'bindingId': entry['bindingId'],
                            }),
                            compact: true,
                          ),
                        button('Change', () {
                          startAdding(
                            '${entry['provider']}:${entry['executionMode']}',
                          );
                          update(() => addingCoordinator = true);
                        }, compact: true),
                        if (entry['bindingId'] != null)
                          button(
                            entry['enabled'] == true ? 'Pause' : 'Resume',
                            () => post('/api/action', {
                              'command':
                                  "/${entry['enabled'] == true ? 'pause' : 'resume'} ${entry['bindingId']}",
                            }),
                            compact: true,
                            primary: entry['enabled'] != true,
                          ),
                      ], detail: entry['cwd'] ?? entry['connection']),
                    ...setupOperation(),
                    gap(16),
                    Row(
                      children: [
                        button('+ Add coordinator', () {
                          startAdding();
                          update(() => addingCoordinator = true);
                        }, primary: true),
                        const SizedBox(width: 14),
                        Expanded(
                          child: small(
                            'Name a coding platform in your chat, or the default answers general requests.',
                          ),
                        ),
                      ],
                    ),
                  ],
                );
          return Dialog(
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: 960,
                maxHeight: MediaQuery.sizeOf(context).height - 48,
              ),
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(26, 24, 26, 26),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Coordinators',
                                style: Theme.of(context)
                                    .textTheme
                                    .headlineLarge,
                              ),
                              gap(4),
                              small('Choose who answers your messages.'),
                            ],
                          ),
                        ),
                        IconButton(
                          tooltip: 'Close',
                          onPressed: () => Navigator.pop(context),
                          icon: const Icon(Icons.close, size: 18),
                        ),
                      ],
                    ),
                    gap(16),
                    body,
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
    modalSetter = null;
    modalContext = null;
  }

  Widget emptyBox(
    String title,
    String detail,
    Widget action, {
    bool logos = false,
  }) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(top: 12),
    constraints: const BoxConstraints(minHeight: 220),
    padding: const EdgeInsets.all(24),
    decoration: BoxDecoration(
      color: toneCharcoal,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: hairline),
    ),
    child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (logos) ...[
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              logoTile('openai', dim: true),
              const SizedBox(width: 6),
              logoTile('claude', dim: true),
            ],
          ),
          gap(14),
        ],
        Text(
          title,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
        gap(6),
        Text(
          detail,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12, color: muted),
        ),
        gap(14),
        action,
      ],
    ),
  );

  Widget voiceDownload() {
    final d = status['voice']?['download'] ?? {};
    final downloading = d['state'] == 'downloading';
    final bytes = (d['bytes'] as num?) ?? 0;
    final total = (d['total'] as num?) ?? 147951465;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (downloading) ...[
          LinearProgressIndicator(
            value: total > 0 ? (bytes / total).clamp(0.0, 1.0) : null,
          ),
          gap(8),
          small(
            'Downloading voice model · ${(bytes / 1048576).toStringAsFixed(1)} / ${(total / 1048576).round()} MB',
          ),
        ] else ...[
          if (d['error'] != null) ...[small(d['error']), gap(8)],
          button(
            d['state'] == 'failed'
                ? 'Retry voice download'
                : 'Download voice model · 141 MB',
            () => post('/api/voice-model'),
            icon: Icons.download_outlined,
          ),
        ],
      ],
    );
  }

  // Mirrors coordinatorFolder() in src/masters.ts; the id suffix is added on create.
  String get coordinatorFolderPreview {
    final name = customName.text.trim();
    var slug = name.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '-');
    slug = slug.replaceAll(RegExp(r'^-+|-+$'), '');
    if (slug.length > 40) slug = slug.substring(0, 40);
    return '~/.farfromdesk/coordinators/${slug.isEmpty ? 'coordinator' : slug}-…';
  }

  Widget masterForm() {
    final entries = (selectedPlatform?['sessions'] ?? [])
        .cast<Map>()
        .where(
          (s) => '${s['name']} ${s['cwd']} ${s['id']}'.toLowerCase().contains(
            search.text.toLowerCase(),
          ),
        )
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        LayoutBuilder(
          builder: (context, box) {
            final columns = box.maxWidth < 640 ? 2 : 4;
            return Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (final p in platforms)
                  SizedBox(
                    width: (box.maxWidth - 10 * (columns - 1)) / columns,
                    child: appTile(p),
                  ),
              ],
            );
          },
        ),
        if (selectedPlatform?['connection'] != null) ...[
          gap(10),
          Row(
            children: [
              Icon(
                selectedPlatform?['connection']['state'] == 'verified'
                    ? Icons.verified_user_outlined
                    : Icons.account_circle_outlined,
                size: 15,
                color: muted,
              ),
              const SizedBox(width: 8),
              Expanded(child: small(selectedPlatform!['connection']['label'])),
            ],
          ),
        ],
        gap(14),
        if (setupAction == 'new') ...[
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: const Color(0x0df4f1ea),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    small('Folder'),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        coordinatorFolderPreview,
                        key: const ValueKey('coordinator-folder'),
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
                gap(4),
                small(
                  'Its own folder. It asks before reading your projects or other folders.',
                ),
              ],
            ),
          ),
          if (platform == 'claude:desktop' &&
              selectedPlatform?['available'] == true &&
              selectedPlatform?['canCreate'] != false) ...[
            gap(14),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: accentWash,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.touch_app_outlined, size: 18, color: accent),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Confirm and send once in Claude',
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        gap(4),
                        small(
                          'Claude opens a new chat in the coordinator folder with the setup message filled in. Confirm the folder, press Send, and FarFromDesk connects it automatically.',
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
          gap(18),
          Row(
            children: [
              const Text('Name', style: TextStyle(color: muted, fontSize: 13)),
              const SizedBox(width: 14),
              Expanded(
                child: TextField(
                  key: const ValueKey('coordinator-name'),
                  controller: customName,
                  enabled: !busy,
                  maxLength: 80,
                  onChanged: (_) =>
                      editSetup(() => coordinatorNameEdited = true),
                  decoration: const InputDecoration(
                    hintText: 'Give your coordinator a name',
                    counterText: '',
                    isDense: true,
                  ),
                ),
              ),
            ],
          ),
        ] else ...[
          TextField(
            controller: search,
            decoration: const InputDecoration(
              hintText: 'Search sessions by name or project',
            ),
            onChanged: (_) => editSetup(() => visibleSessions = 30),
          ),
          gap(10),
          Row(
            children: [
              small('${entries.length} saved chats'),
              const Spacer(),
              small('Latest activity first'),
            ],
          ),
          gap(8),
          SizedBox(
            height: 220,
            child: ListView(
              children: [
                for (final s in entries.take(visibleSessions))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Material(
                      color: canvas,
                      borderRadius: BorderRadius.circular(10),
                      child: InkWell(
                        onTap: busy
                            ? null
                            : () => editSetup(() => selectedNativeId = s['id']),
                        borderRadius: BorderRadius.circular(10),
                        child: Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(
                              color: selectedNativeId == s['id']
                                  ? success
                                  : line,
                            ),
                          ),
                          child: Row(
                            children: [
                              Icon(
                                selectedNativeId == s['id']
                                    ? Icons.check_circle
                                    : Icons.circle_outlined,
                                size: 18,
                                color: selectedNativeId == s['id']
                                    ? success
                                    : muted,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      s['name'] ?? s['id'],
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w500,
                                      ),
                                    ),
                                    gap(4),
                                    Text(
                                      s['cwd'] ?? 'Project unavailable',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 11,
                                        color: muted,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 12),
                              Text(
                                s['available'] == true
                                    ? (platform.endsWith(':desktop') ||
                                              platform == 'claude:cli'
                                          ? 'Native session'
                                          : 'Resume in CLI')
                                    : 'Unavailable',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: s['available'] == true
                                      ? success
                                      : muted,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                if (entries.length > visibleSessions)
                  TextButton(
                    onPressed: () => editSetup(() => visibleSessions += 30),
                    child: const Text('Show 30 more'),
                  ),
                if (entries.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: small(
                      'No matching sessions. Refresh or try another name.',
                    ),
                  ),
              ],
            ),
          ),
          gap(10),
          small(
            selectedNativeId.isEmpty
                ? 'Select the coordinator for this connection.'
                : 'Finish active native turns before resuming this exact conversation.',
          ),
          gap(8),
          small(
            'Desktop keeps the selected chat’s account. CLI resume uses the account shown above. Availability does not verify subscription limits.',
          ),
        ],
        if (selectedPlatform?['available'] != true) ...[
          gap(12),
          small(
            selectedPlatform?['reason'] ??
                'Start the bridge and refresh to discover apps.',
          ),
        ],
        if (preferences['backgroundEnabled'] != true) ...[
          gap(12),
          button('Allow background access', enableBackground),
        ],
      ],
    );
  }

  Widget masterActions() {
    final existing = (selectedPlatform?['sessions'] ?? [])
        .cast<Map>()
        .where((s) => s['id'] == selectedNativeId && s['available'] == true)
        .isNotEmpty;
    final can =
        preferences['backgroundEnabled'] == true &&
        selectedPlatform?['available'] == true &&
        !(status['masterSetup']?['operation']?['status'] == 'creating' &&
            '${status['masterSetup']?['operation']?['provider']}:${status['masterSetup']?['operation']?['executionMode']}' ==
                platform);
    return Wrap(
      spacing: 10,
      runSpacing: 8,
      children: [
        button(
          setupAction == 'new'
              ? (List<Map>.from(status['coordinators'] ?? []).any(
                      (c) =>
                          '${c['provider']}:${c['executionMode']}' == platform,
                    )
                    ? 'Replace $platformName coordinator'
                    : 'Create $platformName coordinator')
              : 'Use selected session',
          submitMaster,
          primary: true,
          enabled:
              can &&
              (setupAction == 'new'
                  ? (selectedPlatform?['canCreate'] != false &&
                        customName.text.trim().isNotEmpty)
                  : existing),
        ),
        button(
          setupAction == 'new' ? 'Use existing session' : 'Create new session',
          () => editSetup(
            () => setupAction = setupAction == 'new' ? 'existing' : 'new',
          ),
        ),
      ],
    );
  }

  bool get setupActive =>
      [
        'creating',
        'needs_action',
      ].contains(status['masterSetup']?['operation']?['status']) &&
      !setupFormRequested;

  Widget appTile(Map p) {
    final id = '${p['provider']}:${p['executionMode']}',
        selected = id == platform;
    final desktop = p['executionMode'] == 'desktop';
    final ok = p['available'] == true && p['canCreate'] != false;
    return Material(
      key: ValueKey('coordinator-platform-$id'),
      color: selected ? const Color(0x1a86c9ad) : const Color(0x0af4f1ea),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(
          color: selected ? accent : hairline,
          width: selected ? 1.5 : 1,
        ),
      ),
      child: InkWell(
        customBorder: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
        ),
        onTap: busy
            ? null
            : () => editSetup(() {
                selectCoordinatorPlatform(id);
                selectedNativeId = '';
                visibleSessions = 30;
                search.clear();
              }),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              logoTile(
                p['provider'] == 'claude' ? 'claude' : 'openai',
                size: 34,
              ),
              const SizedBox(height: 10),
              Text(
                '${p['provider'] == 'claude' ? 'Claude' : 'Codex'} ${desktop ? 'Desktop' : 'CLI'}',
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              Text(
                p['available'] != true
                    ? 'Not detected'
                    : p['canCreate'] == false
                    ? 'Sign in first'
                    : '${desktop ? 'App' : 'Terminal'} · Ready',
                style: TextStyle(fontSize: 11.5, color: ok ? muted : warning),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> enableBackground() async {
    if (await confirm(
      'Allow the bridge to run in the background?',
      'Your linked messaging account can send tasks while this app is closed. You can turn this off at any time. Keep-awake is a separate choice.',
    )) {
      await post('/api/preferences', {
        'backgroundEnabled': true,
        'keepAwake': false,
      });
    }
  }

  Future<void> submitMaster() async {
    final parts = platform.split(':');
    if (setupAction == 'new') {
      await post('/api/master-create', {
        'provider': parts[0],
        'executionMode': parts[1],
        'connectionRevision': selectedPlatform?['connection']?['revision'],
        'name': customName.text.trim(),
        'operationId': const Uuid().v4(),
      });
    } else {
      final s = (selectedPlatform?['sessions'] ?? []).cast<Map>().firstWhere(
        (s) => s['id'] == selectedNativeId,
      );
      if (!await confirm(
        'Use the selected session as your coordinator?',
        '${s['name']}\n${s['cwd']}\nSession: ${s['id']}\n\nThis existing session will receive your requests. Finish any active native turn first. Native project permissions stay intact. When replacing a coordinator, its unfinished bridge requests close; native work may continue.',
      )) {
        return;
      }
      await post('/api/master-select', {
        'provider': parts[0],
        'executionMode': parts[1],
        'connectionRevision': selectedPlatform?['connection']?['revision'],
        'sessionId': selectedNativeId,
        'operationId': const Uuid().v4(),
      });
    }
    // A finished submit returns to the coordinator list; setupActive keeps
    // showing progress while a native start is still pending.
    editSetup(() {
      setupFormRequested = false;
      if (actionError == null) addingCoordinator = false;
    });
  }

  List<Map> get allJobs {
    final pending = List<Map>.from(status['pendingJobs'] ?? []),
        ids = pending.map((j) => j['id']).toSet();
    return [
      ...pending,
      ...List<Map>.from(status['jobs'] ?? [])
          .where((j) => !ids.contains(j['id'])),
    ];
  }

  bool includeJob(Map job, String filter) => switch (filter) {
    'Waiting' => ['queued', 'dispatched', 'submitted'].contains(job['status']),
    'Needs review' =>
      ['uncertain', 'failed'].contains(job['status']) ||
          job['outcome'] == 'blocked',
    'Answered' => job['status'] == 'completed' && job['outcome'] != 'blocked',
    'Closed' => ['reviewed', 'replaced', 'auto_closed'].contains(job['status']),
    _ => true,
  };
  String jobLabel(String state) => switch (state) {
    'submitted' => 'Awaiting reply',
    'dispatched' => 'Sending to agent',
    'uncertain' => 'Needs review',
    'completed' => 'Reply recorded',
    'reviewed' => 'Closed after review',
    'auto_closed' => 'Auto-closed',
    'replaced' => 'Master replaced',
    _ => state[0].toUpperCase() + state.substring(1),
  };
  String requestTitle(Map job) {
    final preview = (job['preview'] ?? '')
        .toString()
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    if (preview.isNotEmpty) return preview;
    final id = job['id'].toString();
    return id.startsWith('report:')
        ? 'Worker report'
        : id.startsWith('master:')
        ? 'Delegated task'
        : 'Message request';
  }

  String requestKind(Map job) => job['id'].toString().startsWith('report:')
      ? 'Worker report'
      : job['id'].toString().startsWith('master:')
      ? 'Worker task'
      : 'Your request';
  Map? requestBinding(Map job) =>
      List<Map>.from(status['bindings'] ?? [])
          .where((b) => b['id'] == job['binding_id'])
          .firstOrNull;
  String requestState(Map job) => switch (job['outcome']) {
    'done' => 'Done',
    'blocked' => 'Blocked',
    'reviewed' => 'Reviewed',
    'cancelled' => 'Cancelled',
    _ => jobLabel(job['status']),
  };
  Future<void> recoveryGuide() async {
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Your requests stay saved'),
        content: const SizedBox(
          width: 460,
          child: Text(
            'Closing the window keeps work running when background access is on. If the service stops, unsent requests resume when it starts again. Replies wait for their original messaging channel to reconnect.\n\nFor a request needing review, check the exact native chat first. Close tracking if you already received the answer or no longer need it. Uncertain tasks are never resent automatically.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  List<Widget> activityScreen() {
    final approvals = List<Map>.from(status['approvals'] ?? []);
    if (!connected && allJobs.isEmpty && approvals.isEmpty) {
      return [
        card(
          Container(
            constraints: const BoxConstraints(minHeight: 280),
            alignment: Alignment.center,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                logoTile('whatsapp'),
                gap(14),
                const Text(
                  'No activity yet',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                ),
                gap(6),
                const SizedBox(
                  width: 320,
                  child: Text(
                    'Your requests and permission questions appear here once your messaging account is connected.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 12, color: muted),
                  ),
                ),
                gap(14),
                button('Connect your chat', () => go(0), primary: true),
              ],
            ),
          ),
        ),
      ];
    }
    final query = activityQuery.trim().toLowerCase();
    final jobs =
        allJobs
            .where(
              (j) =>
                  includeJob(j, activityFilter) &&
                  '${requestTitle(j)} ${requestBinding(j)?['name'] ?? ''} ${j['id']}'
                      .toLowerCase()
                      .contains(query),
            )
            .toList()
          ..sort(
            (a, b) =>
                (b['created_at'] as num).compareTo(a['created_at'] as num),
          );
    final eligibleIds = jobs
        .where((j) => j['canClose'] == true)
        .take(500)
        .map((j) => j['id'] as String)
        .toSet();
    final allSelected =
        eligibleIds.isNotEmpty && chosen.containsAll(eligibleIds);
    final someSelected = eligibleIds.any(chosen.contains);
    void toggleSelection() => changeView(() {
      if (allSelected) {
        chosen.removeAll(eligibleIds);
      } else {
        chosen.addAll(eligibleIds);
      }
    });
    const filters = ['All', 'Waiting', 'Needs review', 'Answered', 'Closed'];
    final rows = <Widget>[];
    String? lastDay;
    for (final j in jobs) {
      final day = dayLabel(j['created_at']);
      if (day != lastDay) {
        rows.add(
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
            child: Text(
              day,
              style: const TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                color: muted,
              ),
            ),
          ),
        );
        lastDay = day;
      }
      rows.add(activityRow(j, selectable: eligibleIds.isNotEmpty));
    }
    return [
      for (final a in approvals)
        panel(
          '${a['alias']} needs your input',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: toneInk.withValues(alpha: .08),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: SelectableText(
                  a['question'],
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12.5,
                    color: toneInk,
                  ),
                ),
              ),
              gap(14),
              Wrap(
                spacing: 10,
                children: [
                  if (a['kind'] == 'approval') ...[
                    button(
                      'Allow once',
                      () => post('/api/action', {
                        'command': '/approve ${a['code']}',
                      }),
                      primary: true,
                    ),
                    button(
                      'Deny',
                      () => post('/api/action', {
                        'command': '/deny ${a['code']}',
                      }),
                    ),
                  ] else
                    button('Send answer', () async {
                      final answer = await ask(a['question']);
                      if (answer != null && answer.isNotEmpty) {
                        await post('/api/action', {
                          'command': '/answer ${a['code']} $answer',
                        });
                      }
                    }, primary: true),
                ],
              ),
            ],
          ),
          tone: toneAmber,
          light: true,
        ),
      card(
        Row(
          children: [
            const Icon(Icons.history_rounded, size: 18, color: accent),
            const SizedBox(width: 12),
            Expanded(
              child: small(
                '${(status['pendingJobs'] ?? []).length} unfinished · Requests are saved on this $computer',
              ),
            ),
            TextButton(
              onPressed: recoveryGuide,
              child: const Text('How recovery works'),
            ),
          ],
        ),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
      ),
      if (List<Map>.from(status['voiceRequests'] ?? []).any(
        (v) =>
            ['failed', 'routing_blocked', 'interrupted'].contains(v['status']),
      ))
        panel(
          'Voice notes needing attention',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              small(
                'Transcription and routing are tracked separately. Check the problem before resending.',
              ),
              for (final v
                  in List<Map>.from(status['voiceRequests'] ?? [])
                      .where(
                        (v) => [
                          'failed',
                          'routing_blocked',
                          'interrupted',
                        ].contains(v['status']),
                      )
                      .take(5))
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    v['status'] == 'routing_blocked'
                        ? 'Transcribed · routing blocked'
                        : 'Voice note ${v['status']}',
                  ),
                  subtitle: small(v['id']),
                  trailing: button(
                    'Details',
                    () => requestTimeline(v['id']),
                    compact: true,
                  ),
                ),
            ],
          ),
        ),
      if ((status['unlinkedUpdates'] ?? []).isNotEmpty)
        panel(
          'Native updates saved for review',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              small(
                'These updates have no verified request link. They stay on this computer to avoid sending a duplicate or addressing the wrong request. Latest 50 · retained for 7 days.',
              ),
              for (final u in List<Map>.from(
                status['unlinkedUpdates'],
              ).take(10))
                ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  title: Text(
                    List<Map>.from(status['bindings'] ?? [])
                            .where((b) => b['id'] == u['binding_id'])
                            .firstOrNull?['name'] ??
                        'Native session update',
                  ),
                  subtitle: small(
                    DateTime.fromMillisecondsSinceEpoch(u['at'])
                        .toLocal()
                        .toString(),
                  ),
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: button(
                        'Read local update',
                        () => readLocalUpdate(u['id']),
                        compact: true,
                      ),
                    ),
                  ],
                ),
            ],
          ),
        ),
      card(
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Request history',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      gap(2),
                      small(
                        'Every request, which session took it and what happened.',
                      ),
                    ],
                  ),
                ),
                SizedBox(
                  width: 260,
                  child: TextField(
                    onChanged: (value) =>
                        changeView(() => activityQuery = value),
                    decoration: InputDecoration(
                      hintText: 'Search requests or sessions',
                      prefixIcon: const Icon(
                        Icons.search,
                        size: 18,
                        color: muted,
                      ),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 11,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(999),
                        borderSide: const BorderSide(color: line2),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(999),
                        borderSide: const BorderSide(color: line2),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(999),
                        borderSide: const BorderSide(color: accent, width: 1.5),
                      ),
                    ),
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
              ],
            ),
            gap(16),
            Row(
              children: [
                Flexible(
                  child: segmented(
                    filters,
                    activityFilter,
                    (filter) => changeView(() => activityFilter = filter),
                    key: const ValueKey('activity-filter-group'),
                    compact: true,
                    counts: {
                      for (final f in filters)
                        f: allJobs.where((j) => includeJob(j, f)).length,
                    },
                  ),
                ),
                const SizedBox(width: 12),
                if (eligibleIds.isNotEmpty || chosen.isNotEmpty)
                  Tooltip(
                    message: 'Select reviewable requests in this list',
                    child: InkWell(
                      borderRadius: BorderRadius.circular(8),
                      onTap: eligibleIds.isEmpty ? null : toggleSelection,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Checkbox(
                            key: const ValueKey('select-visible-requests'),
                            tristate: true,
                            value: allSelected
                                ? true
                                : someSelected
                                ? null
                                : false,
                            onChanged: eligibleIds.isEmpty
                                ? null
                                : (_) => toggleSelection(),
                          ),
                          const Text(
                            'Select all',
                            style: TextStyle(fontSize: 12.5),
                          ),
                          const SizedBox(width: 8),
                        ],
                      ),
                    ),
                  ),
                if (chosen.isNotEmpty) ...[
                  TextButton(
                    onPressed: () => changeView(chosen.clear),
                    child: const Text('Clear'),
                  ),
                  button(
                    'Close selected (${chosen.length})…',
                    bulkClose,
                    compact: true,
                  ),
                ],
              ],
            ),
            gap(14),
            Container(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
              decoration: const BoxDecoration(
                border: Border(bottom: BorderSide(color: hairline)),
              ),
              child: Row(
                children: [
                  SizedBox(width: eligibleIds.isNotEmpty ? 80 : 48),
                  Expanded(child: small('Request')),
                  SizedBox(width: 92, child: small('Received')),
                  SizedBox(width: 190, child: small('Status')),
                  const SizedBox(width: 40),
                ],
              ),
            ),
            if (jobs.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 36),
                child: Center(
                  child: Column(
                    children: [
                      Text(
                        query.isNotEmpty || activityFilter != 'All'
                            ? 'No matching requests'
                            : 'No requests here yet',
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      gap(6),
                      small(
                        query.isNotEmpty || activityFilter != 'All'
                            ? 'Try another filter or search.'
                            : 'Send a task in your connected chat to get started.',
                      ),
                    ],
                  ),
                ),
              ),
            ...rows,
            gap(14),
            Row(
              children: [
                Expanded(
                  child: small('Showing ${jobs.length} of ${allJobs.length}'),
                ),
                small('All unfinished + latest 100'),
              ],
            ),
          ],
        ),
      ),
    ];
  }

  String dayLabel(num at) {
    final t = DateTime.fromMillisecondsSinceEpoch(at.toInt()).toLocal();
    final now = DateTime.now();
    final days = DateTime(
      now.year,
      now.month,
      now.day,
    ).difference(DateTime(t.year, t.month, t.day)).inDays;
    return days == 0
        ? 'Today'
        : days == 1
        ? 'Yesterday'
        : '${t.day.toString().padLeft(2, '0')}/${t.month.toString().padLeft(2, '0')}/${t.year}';
  }

  String clock(num at) {
    final t = DateTime.fromMillisecondsSinceEpoch(at.toInt()).toLocal();
    return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  }

  Widget activityRow(Map job, {bool selectable = false}) {
    final binding = requestBinding(job);
    final st = '${job['status']}';
    final waiting = ['queued', 'dispatched', 'submitted'].contains(st);
    final review =
        ['uncertain', 'failed'].contains(st) || job['outcome'] == 'blocked';
    final blocked = job['outcome'] == 'blocked';
    final closed = ['reviewed', 'replaced', 'auto_closed'].contains(st);
    final selected = chosen.contains(job['id']);
    final app =
        '${{'claude': 'Claude', 'codex': 'Codex'}[binding?['provider']] ?? 'Coding'} ${{'desktop': 'Desktop', 'cli': 'CLI'}[binding?['executionMode']] ?? 'session'}';
    final session = binding?['name'] ?? binding?['alias'] ?? 'Coding session';
    final received = clock(job['created_at']);
    final sending = ['queued', 'dispatched'].contains(st);
    final chip = waiting
        ? tag(requestState(job), spinning: true)
        : blocked
        ? tag('Blocked', tint: danger)
        : review
        ? tag(requestState(job), tint: warning)
        : st == 'completed'
        ? tag(requestState(job), good: true)
        : tag(requestState(job));
    return Container(
      margin: const EdgeInsets.only(top: 2),
      child: Material(
        color: selected ? accent.withValues(alpha: .08) : Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        child: ExpansionTile(
          key: PageStorageKey('request-${job['id']}'),
          tilePadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
          childrenPadding: const EdgeInsets.fromLTRB(62, 0, 14, 14),
          backgroundColor: const Color(0x0af4f1ea),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: hairline),
          ),
          collapsedShape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          title: Row(
            children: [
              if (selectable) ...[
                SizedBox(
                  width: 24,
                  child: job['canClose'] != true
                      ? null
                      : Checkbox(
                          value: selected,
                          onChanged: (value) => changeView(() {
                            if (value == true) {
                              chosen.add(job['id']);
                            } else {
                              chosen.remove(job['id']);
                            }
                          }),
                        ),
                ),
                const SizedBox(width: 8),
              ],
              logoTile(
                binding?['provider'] == 'claude' ? 'claude' : 'openai',
                size: 34,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      requestTitle(job),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      '${requestKind(job)} · $app · $session',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11.5, color: muted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 14),
              SizedBox(width: 92, child: small(received)),
              SizedBox(
                width: 190,
                child: Align(alignment: Alignment.centerLeft, child: chip),
              ),
            ],
          ),
          children: [
            stepRow('Received from your chat', detail: received, state: 'done'),
            stepRow(
              sending ? 'Sending to session' : 'Sent to session',
              detail: '$session · $app',
              state: sending ? 'now' : 'done',
            ),
            stepRow(
              sending
                  ? 'Reply'
                  : st == 'submitted'
                  ? 'Awaiting reply'
                  : requestState(job),
              detail: sending
                  ? 'Sent to the original chat when the session answers'
                  : review && job['outcome'] == null
                  ? (job['error'] ??
                        'Delivery or completion could not be confirmed. Check the native chat before sending anything again. This request will not be resent automatically.')
                  : job['error'],
              state: sending
                  ? 'pending'
                  : st == 'submitted'
                  ? 'now'
                  : blocked
                  ? 'fail'
                  : review
                  ? 'wait'
                  : 'done',
            ),
            if (job['last_error'] != null && job['error'] == null) ...[
              gap(8),
              Align(
                alignment: Alignment.centerLeft,
                child: small(
                  'Earlier error (cleared after a later response): ${job['last_error']}',
                ),
              ),
            ],
            gap(10),
            Row(
              children: [
                Expanded(
                  // SelectableText has an internal scroll position that shares
                  // the ExpansionTile's PageStorage bucket (bool vs. double).
                  child: SelectionArea(
                    child: Text(
                      'Request ID ${job['id']} · Session ${binding?['native_id'] ?? 'unknown'} · ${binding?['cwd'] ?? 'Project unavailable'}',
                      style: const TextStyle(fontSize: 11, color: muted),
                    ),
                  ),
                ),
                Wrap(
                  spacing: 8,
                  children: [
                    if (job['canClose'] == true)
                      button(
                        'Mark reviewed',
                        () async {
                          if (await confirm(
                            'Close this request after review?',
                            'This ends tracking for the exact request. History is kept; native work is not stopped or marked successful.',
                          )) {
                            await post('/api/request-review', {
                              'requestId': job['id'],
                              'expectedStatus': job['status'],
                              'confirmed': true,
                            });
                          }
                        },
                        primary: true,
                        compact: true,
                      ),
                    if (!closed && st != 'completed')
                      button(
                        'Send reviewed document',
                        () => document(job),
                        compact: true,
                      ),
                    button(
                      'Timing and delivery',
                      () => requestTimeline(job['id']),
                      compact: true,
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> readLocalUpdate(String id) async {
    Map<String, dynamic>? loaded;
    await act(() async {
      loaded = await api.get('/api/hook-update?id=${Uri.encodeComponent(id)}');
    });
    if (!mounted || loaded == null) return;
    final data = loaded!;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Local native update'),
        content: SizedBox(
          width: 560,
          height: 360,
          child: SingleChildScrollView(
            child: SelectableText(data['text'] ?? 'Unavailable'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  Future<void> requestTimeline(String id) async {
    Map<String, dynamic>? loaded;
    await act(() async {
      loaded = await api.get(
        '/api/request-events?id=${Uri.encodeComponent(id)}',
      );
    });
    if (!mounted || loaded == null) return;
    final data = loaded!;
    final events = List<Map>.from(data['events'] ?? []);
    final deliveries = List<Map>.from(data['deliveries'] ?? []);
    String time(dynamic value) => value is num
        ? DateTime.fromMillisecondsSinceEpoch(value.toInt())
              .toLocal()
              .toString()
        : 'Not observed';
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Request timing and delivery'),
        content: SizedBox(
          width: 600,
          height: 420,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SelectableText(
                  id,
                  style: const TextStyle(color: muted, fontSize: 12),
                ),
                gap(12),
                const Text(
                  'Sent means accepted by the messaging service. Telegram does not provide delivery or read receipts. Delivery and read receipts appear only when observed; none of these proves the task succeeded.',
                ),
                if (events.isEmpty) ...[
                  gap(12),
                  const Text(
                    'Timing was not recorded for this older request. Historical completion times are unknown.',
                  ),
                ],
                for (final e in events)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: SelectableText(
                      '${time(e['at'])} · ${e['event']}\n${e['details']}${e['turn_id'] == null ? '' : '\nTurn: ${e['turn_id']}'}',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                for (final d in deliveries)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text(
                      '${d['reply_kind'] ?? 'Reply'} · ${d['status']} · ${d['attempts']} retries\nSent: ${time(d['sent_at'])}\nDelivered: ${time(d['delivered_at'])}\nRead: ${time(d['read_at'])}',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  Future<void> bulkClose() async {
    final snapshot = allJobs
        .where((j) => chosen.contains(j['id']) && j['canClose'] == true)
        .toList();
    if (snapshot.isEmpty) return;
    if (await confirm(
      'Close ${snapshot.length} selected requests?',
      'Close tracking only if their answers arrived or you no longer need their replies. History is kept. This does not stop native work, resend tasks or mark them successful. If any selected request changes, nothing will be closed.',
    )) {
      await act(() async {
        await api.post('/api/request-review-bulk', {
          'confirmed': true,
          'requests': snapshot
              .map(
                (j) => {
                  'requestId': j['id'],
                  'expectedStatus': j['status'],
                  'expectedUpdatedAt': j['updated_at'] ?? j['created_at'],
                },
              )
              .toList(),
        });
        chosen.clear();
      });
    }
  }

  Widget settingRow(String title, String detail, Widget control) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              gap(2),
              Text(
                detail,
                style: const TextStyle(fontSize: 12, height: 1.5, color: muted),
              ),
            ],
          ),
        ),
        const SizedBox(width: 16),
        control,
      ],
    ),
  );
  List<Widget> settingsScreen() {
    final cleanup =
        status['requestCleanup'] ?? {'enabled': false, 'afterHours': 24};
    return [
      messagingAppSettings(),
      panel(
        'On this $computer',
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            settingRow(
              'Run in the background',
              'Receive tasks while the window is closed. Turning this off disconnects messaging and pauses forwarding.',
              Switch(
                value: preferences['backgroundEnabled'] == true,
                onChanged: busy
                    ? null
                    : (v) {
                        if (v) {
                          enableBackground();
                        } else {
                          post('/api/preferences', {
                            'backgroundEnabled': false,
                            'keepAwake': false,
                          });
                        }
                      },
              ),
            ),
            const Divider(height: 1),
            settingRow(
              'Open at login',
              'Launch FarFromDesk when you sign in to this $computer.',
              Switch(
                value: startup,
                onChanged: busy
                    ? null
                    : (v) => act(() async {
                        await api.setStartup(v);
                        startup = await api.startupEnabled();
                      }),
              ),
            ),
            const Divider(height: 1),
            settingRow(
              'Keep awake while locked',
              'Keep work running with the lid open, even when the screen is locked or off. Your password and lock screen stay enabled.',
              Switch(
                value: preferences['keepAwake'] == true,
                onChanged: busy || preferences['backgroundEnabled'] != true
                    ? null
                    : (v) async {
                        if (!v ||
                            await confirm(
                              'Keep this $computer awake while locked?',
                              'This uses battery and does not bypass your password, native approvals, manual sleep or lid-close sleep. Turn it off to restore normal idle sleep.',
                            )) {
                          await post('/api/preferences', {
                            'backgroundEnabled': true,
                            'keepAwake': v,
                          });
                        }
                      },
              ),
            ),
            if (preferences['backgroundEnabled'] != true) ...[
              gap(10),
              small('Enable background access to use sleep prevention.'),
            ],
            if (preferences['assertionActive'] == true) ...[
              gap(10),
              tag('Keep-awake active · screen may lock', good: true),
            ],
            if (preferences['error'] != null) ...[
              gap(10),
              Text(
                preferences['error'],
                style: const TextStyle(fontSize: 11, color: warning),
              ),
            ],
          ],
        ),
        trailing: tag(
          error == null ? 'Bridge running' : 'Bridge offline',
          good: error == null,
        ),
      ),
      panel(
        'Request cleanup',
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            settingRow(
              'Auto-close stale requests',
              'Close tracking after no recorded updates for the chosen period. Keeps history; never stops native work or marks a task successful.',
              Switch(
                value: cleanup['enabled'] == true,
                onChanged: busy
                    ? null
                    : (v) async {
                        if (!v ||
                            await confirm(
                              'Enable automatic request cleanup?',
                              'Eligible requests with no recorded updates for ${cleanup['afterHours']} hours will be marked Auto-closed, including existing old requests. History is kept and native work continues.',
                            )) {
                          await post('/api/request-cleanup', {
                            'enabled': v,
                            'afterHours': cleanup['afterHours'],
                          });
                        }
                      },
              ),
            ),
            gap(14),
            Row(
              children: [
                const Text('Close after no updates for'),
                const Spacer(),
                dropdown<int>(
                  width: 180,
                  value: [24, 72, 168].contains(cleanup['afterHours'])
                      ? cleanup['afterHours']
                      : 24,
                  items: const [
                    DropdownMenuItem(value: 24, child: Text('24 hours')),
                    DropdownMenuItem(value: 72, child: Text('3 days')),
                    DropdownMenuItem(value: 168, child: Text('7 days')),
                  ],
                  onChanged: (hours) {
                    if (hours != null) {
                      post('/api/request-cleanup', {
                        'enabled': cleanup['enabled'] == true,
                        'afterHours': hours,
                      });
                    }
                  },
                ),
              ],
            ),
            gap(10),
            small(
              'Queued requests, known active deliveries, pending bridge permissions and unfinished delegated work are excluded. A submitted session may still be working without sending updates; auto-close only ends tracking. Late replies are still accepted.',
            ),
            TextButton(
              onPressed: () => go(1),
              child: const Text('Review or bulk-close in Activity'),
            ),
          ],
        ),
      ),
      panel(
        'Access & availability',
        Column(
          children: [
            settingsDisclosure(
              icon: Icons.laptop_mac,
              title: 'Keep your $computer available',
              subtitle: 'Lock screen, sleep and closed-lid behaviour',
              children: [
                settingRow(
                  'Lock screen',
                  'Work keeps running while the screen is locked.',
                  tag('Works', good: true),
                ),
                settingRow(
                  'Sleep',
                  preferences['keepAwake'] == true
                      ? 'This $computer stays awake while work is running.'
                      : 'Turn on Keep awake while locked to stop idle sleep.',
                  preferences['keepAwake'] == true
                      ? tag('Covered', good: true)
                      : tag('Off'),
                ),
                settingRow(
                  'Closed lid',
                  'Keep an operating laptop ventilated, never in a bag. Sleep prevention does not override manual sleep, lid-close sleep or low-battery protection. If this $computer sleeps or loses internet, your messages cannot reach it.',
                  tag('Pauses'),
                ),
              ],
            ),
            gap(10),
            settingsDisclosure(
              icon: Icons.shield_outlined,
              title: 'Your account & permissions',
              subtitle: 'Your account, coordinators and native approvals',
              children: [
                settingRow(
                  'Owner account',
                  usingTelegram
                      ? '${status['telegram']?['ownerName'] ?? 'Your confirmed Telegram account'} is the only Telegram account that can send tasks.'
                      : '${status['whatsapp']?['phoneNumber'] ?? 'Your linked WhatsApp account'} is the only WhatsApp account that can send tasks.',
                  connected ? tag('Linked', good: true) : tag('Not linked'),
                ),
                settingRow(
                  'Coordinators',
                  'Choose the coding app that answers your messages.',
                  button('Manage', openManage, compact: true),
                ),
                settingRow(
                  'Native approvals',
                  'Prompts shown by Claude or Codex still need you at this $computer. Pausing the bridge does not stop work already running.',
                  tag('Always on'),
                ),
              ],
            ),
            gap(10),
            settingsDisclosure(
              icon: Icons.graphic_eq,
              title: 'Voice notes',
              subtitle: status['voice']?['ready'] != true
                  ? 'Not set up'
                  : status['voice']?['local'] == false
                  ? 'Transcribed by ${voiceName(status['voice']?['engine'])}'
                  : 'Transcribed on this $computer',
              children: [
                gap(12),
                voiceSetup(),
                gap(18),
                small('Advanced: use your own FFmpeg, whisper-cli and model.'),
                gap(10),
                for (final item in [
                  ('ffmpeg', 'FFmpeg executable'),
                  ('whisper', 'whisper-cli executable'),
                  ('model', 'Whisper model'),
                ])
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            audio[item.$1] ?? item.$2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 12, color: muted),
                          ),
                        ),
                        button('Choose ${item.$1}', () async {
                          final path = await api.chooseFile(item.$2);
                          if (path != null && mounted) {
                            changeView(() => audio[item.$1] = path);
                          }
                        }),
                      ],
                    ),
                  ),
                button(
                  'Save voice settings',
                  () => post('/api/audio-config', audio),
                  primary: true,
                  enabled: audio.length == 3,
                ),
              ],
            ),
          ],
        ),
      ),
      panel(
        'App updates',
        Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    checkingUpdates
                        ? 'Checking for updates…'
                        : update.release != null
                        ? 'Version ${update.release!.version} is available'
                        : update.problem ??
                              (update.checkedAt == null
                                  ? 'Checked when the app opens'
                                  : 'You are up to date'),
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  gap(2),
                  small(
                    update.release != null
                        ? 'Installs after your current work finishes.'
                        : 'Updates are checked when the app opens, then every hour.',
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            OutlinedButton(
              onPressed: checkingUpdates || busy
                  ? null
                  : () => checkUpdates(manual: true),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (checkingUpdates) ...[
                    SizedBox(width: 13, height: 13, child: spinner(ink)),
                    const SizedBox(width: 8),
                  ],
                  Text(checkingUpdates ? 'Checking…' : 'Check for updates'),
                ],
              ),
            ),
            if (update.release != null) ...[
              const SizedBox(width: 10),
              button('Update now', showUpdate, primary: true),
            ],
          ],
        ),
        trailing: small('v$installedVersion'),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
        child: small(
          'This $computer and your agent provider must be online. Queued replies are retained during outages.',
        ),
      ),
    ];
  }

  Widget settingsDisclosure({
    required IconData icon,
    required String title,
    required String subtitle,
    required List<Widget> children,
  }) {
    final border = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(14),
      side: const BorderSide(color: hairline),
    );
    return ExpansionTile(
      tilePadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      childrenPadding: const EdgeInsets.fromLTRB(62, 0, 16, 6),
      backgroundColor: const Color(0x08f4f1ea),
      collapsedBackgroundColor: const Color(0x08f4f1ea),
      shape: border,
      collapsedShape: border,
      leading: Container(
        width: 34,
        height: 34,
        decoration: BoxDecoration(
          color: surface,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(icon, size: 18, color: accent),
      ),
      title: Text(
        title,
        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
      ),
      subtitle: small(subtitle),
      children: children,
    );
  }
}

class _DashedBorder extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(18)),
      );
    final paint = Paint()
      ..color = line
      ..style = PaintingStyle.stroke;
    for (final metric in path.computeMetrics()) {
      for (var d = 0.0; d < metric.length; d += 9) {
        canvas.drawPath(metric.extractPath(d, d + 5), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_) => false;
}

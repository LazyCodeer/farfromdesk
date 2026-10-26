part of 'app.dart';

// Layout is ported from the build-41 SwiftUI views. Only OS wording and verified
// integration availability differ; component geometry and navigation are shared.
extension _BridgeScreens on _DeskState {
  bool get connected => status['whatsapp']?['status'] == 'connected';
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
                  'Your WhatsApp connection and coding assistant.',
                  'See which session answered and what needs your attention.',
                  'Decide when FarFromDesk runs and how this $computer stays available.',
                ][section],
                style: const TextStyle(fontSize: 12, color: muted),
              ),
            ],
          ),
        ),
        if (ready) ...[
          if (connected) ...[
            tag('Connected', good: true),
            const SizedBox(width: 12),
            spinButton('Refresh connection', 'Refreshing…', refresh),
          ] else ...[
            tag('Not connected', tint: warning),
            const SizedBox(width: 12),
            button(
              status['whatsapp']?['qr'] != null
                  ? 'Check connection'
                  : 'Show QR code',
              connectPhone,
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
    Widget left(bool stretch) => connected
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
      if (wa['error'] != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(wa['error'], style: const TextStyle(color: warning)),
        ),
      if (!connected)
        nextSteps()
      else ...[
        card(coordinatorSummary()),
        voiceCard(),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
          child: small(
            'Pause forwarding in Settings, or use Log out above to unlink this device.',
          ),
        ),
      ],
    ];
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
            button('Log out…', logout, destructive: true),
          ],
        ),
        gap(16),
        const Text(
          'Only this account can control FarFromDesk.',
          style: TextStyle(color: onPineMuted),
        ),
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
            'Connect WhatsApp',
            'Scan the QR code above with your phone.',
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
            'Message yourself',
            'Ask for an update or start work from your phone.',
          ),
        ],
      ),
    );
  }

  Widget voiceCard() {
    final voice = status['voice']?['ready'] == true;
    final download = status['voice']?['download'] != null;
    return card(
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: surface,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              voice ? Icons.graphic_eq : Icons.mic_off_outlined,
              color: voice ? accent : warning,
              size: 20,
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  voice
                      ? 'Voice notes ready'
                      : download
                      ? 'Voice model setup'
                      : 'Voice notes unavailable',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                gap(4),
                Text(
                  voice
                      ? 'Send a voice note in your connected chat. Audio is processed locally on this $computer.'
                      : download
                      ? 'The model downloads once on your first voice note. You can also download it now.'
                      : 'Configure local speech tools in Settings to enable voice notes.',
                  style: const TextStyle(fontSize: 12, color: muted),
                ),
                if (download) ...[gap(12), voiceDownload()],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> logout() async {
    if (await confirm(
      'Log out of WhatsApp?',
      'Unlink this device and pause forwarding and keep-awake. Your master, selected sessions and request history are kept. Work already running in native apps may continue.',
    )) {
      await post('/api/logout', {'confirmed': true});
    }
  }

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
            else
              Row(
                children: [
                  Expanded(
                    child: dropdown<String>(
                      value: current?['id'],
                      hint: groups.isEmpty
                          ? 'No groups with only you'
                          : 'Choose a group',
                      items: [
                        for (final group in groups)
                          DropdownMenuItem(
                            value: group['id'] as String,
                            child: Text(group['name'] ?? 'Group'),
                          ),
                      ],
                      onChanged: (id) {
                        if (id != null) {
                          post('/api/destination', {'jid': id});
                        }
                      },
                    ),
                  ),
                  const SizedBox(width: 10),
                  button('Create group', createGroup),
                  const SizedBox(width: 6),
                  IconButton(
                    tooltip: 'Refresh groups',
                    onPressed: busy ? null : loadGroups,
                    icon: const Icon(Icons.refresh, size: 18, color: muted),
                  ),
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

  Future<void> loadGroups() async {
    if (loadingGroups || !mounted) return;
    changeView(() {
      loadingGroups = true;
      groupsError = null;
    });
    try {
      final d = await api.get('/api/group-recover');
      if (mounted) changeView(() => groups = List<Map>.from(d['groups'] ?? []));
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

  Widget codingPlatformsCard() {
    final found = platforms.any((p) => p['available'] == true);
    Widget link(String label, String url) => TextButton(
      onPressed: () => act(() => api.openReleasePage(Uri.parse(url))),
      child: Text(label),
    );
    return panel(
      'Coding platforms',
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
                    refresh,
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
                        ? 'Default for WhatsApp'
                        : 'Used when a message names ${entry['provider'] == 'claude' ? 'Claude' : 'Codex'}')}',
              ),
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
            'It reads your WhatsApp messages and starts or checks coding sessions for you.',
          ),
          ...setupOperation(),
          gap(16),
          masterForm(),
          gap(16),
          masterActions(),
        ],
      );
    }
    final answering = entries.where((e) => e['enabled'] == true).length;
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
                    'Running in the background is off, so WhatsApp messages wait until you turn it back on.',
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
            button(
              'Instructions',
              () => openManage(tab: 'Instructions'),
              compact: true,
            ),
            entry['enabled'] != true
                ? tag('Paused')
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
                'Name a platform in WhatsApp, or the default answers general requests.',
              ),
            ),
            const SizedBox(width: 12),
            button('Manage coordinators', openManage, primary: true),
          ],
        ),
      ],
    );
  }

  /// One dialog for who answers WhatsApp (coordinators), what they were told
  /// (instructions) and which worker sessions they may use.
  Future<void> openManage({
    String tab = 'Coordinators',
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
      setupAction = 'new';
      setupFormRequested = false;
      selectedNativeId = '';
      search.clear();
      visibleSessions = 30;
    });
    if (adding) startAdding(requestedPlatform);
    if (another) editSetup(() => setupFormRequested = true);
    await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) {
          modalUpdate = update;
          final entries = coordinatorEntries;
          final Widget body = switch (tab) {
            'Instructions' => instructionsTab(),
            'Connected sessions' => sessionsTab(),
            _ =>
              setupActive
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
                  : adding || entries.isEmpty && setupFormRequested
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (entries.isNotEmpty)
                          TextButton.icon(
                            onPressed: () => update(() => adding = false),
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
                                    ? 'Pick the app that should answer your WhatsApp requests.'
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
                      'Add one so your WhatsApp messages have someone to answer them.',
                      button('+ Add coordinator', () {
                        startAdding();
                        update(() => adding = true);
                      }, primary: true),
                      logos: true,
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final entry in entries)
                          coordinatorRow(entry, [
                            button(
                              'Instructions',
                              () => update(() => tab = 'Instructions'),
                              compact: true,
                            ),
                            entry['enabled'] != true
                                ? tag('Paused')
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
                              update(() => adding = true);
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
                              update(() => adding = true);
                            }, primary: true),
                            const SizedBox(width: 14),
                            Expanded(
                              child: small(
                                'Name a platform in WhatsApp, or the default answers general requests.',
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
          };
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
                              small(
                                'Who answers your WhatsApp messages, what they were told, and which sessions they can use.',
                              ),
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
                    segmented(
                      ['Coordinators', 'Instructions', 'Connected sessions'],
                      tab,
                      (value) => update(() => tab = value),
                      compact: true,
                    ),
                    gap(8),
                    body,
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
    modalUpdate = null;
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

  Widget instructionsTab() {
    final delivery = status['masterSetup']?['roleDelivery']?['state'];
    final prompt =
        status['masterSetup']?['prompt'] ?? 'Instructions unavailable.';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        gap(4),
        Row(
          children: [
            Expanded(
              child: Text(
                'Coordinator instructions',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            switch (delivery) {
              'sent' => tag('Applied', good: true),
              'unselected' => tag('No session'),
              null => const SizedBox.shrink(),
              _ => tag('Ready to apply', tint: warning),
            },
          ],
        ),
        if (delivery != null) ...[
          gap(10),
          small(
            delivery == 'sent'
                ? 'Applied to this session. Later messages use a short reference.'
                : delivery == 'unselected'
                ? 'Select a coordinator session to apply these instructions.'
                : 'Ready to apply with your next message.',
          ),
        ],
        Container(
          width: double.infinity,
          margin: const EdgeInsets.only(top: 14),
          constraints: const BoxConstraints(maxHeight: 340),
          padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
          decoration: BoxDecoration(
            color: toneCharcoal,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: hairline),
          ),
          child: SingleChildScrollView(
            child: MarkdownBody(
              data: prompt,
              selectable: true,
              imageBuilder: (uri, title, alt) => const SizedBox.shrink(),
              styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context))
                  .copyWith(
                    p: const TextStyle(
                      fontSize: 13,
                      height: 1.65,
                      color: Color(0xffd9d6cc),
                    ),
                    h1: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                    ),
                    h2: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                    h3: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                    listBullet: const TextStyle(
                      fontSize: 13,
                      height: 1.65,
                      color: Color(0xffd9d6cc),
                    ),
                  ),
            ),
          ),
        ),
        gap(16),
        button(
          'Copy instructions',
          () => Clipboard.setData(ClipboardData(text: prompt)),
        ),
      ],
    );
  }

  Widget sessionsTab() {
    final sessions = List<Map>.from(status['bindings'] ?? []);
    if (sessions.isEmpty) {
      return emptyBox(
        'No connected sessions',
        'Pick the coding sessions your coordinators may send work to.',
        button('Choose sessions', browse, primary: true),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final s in sessions)
          coordinatorRow(
            {...s, 'executionMode': s['executionMode'] ?? s['execution_mode']},
            const [],
            detail: s['cwd'] ?? 'Project unavailable',
          ),
        gap(16),
        Row(
          children: [
            button('Choose sessions', browse, primary: true),
            const SizedBox(width: 14),
            Expanded(
              child: small(
                'Coordinators can only send work to sessions you pick here.',
              ),
            ),
          ],
        ),
      ],
    );
  }

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
    final name = automaticName
        ? 'FarFromDesk · $platformName'
        : customName.text.trim();
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
                child: automaticName
                    ? Text(
                        'FarFromDesk · $platformName',
                        overflow: TextOverflow.ellipsis,
                      )
                    : TextField(
                        controller: customName,
                        maxLength: 80,
                        onChanged: (_) => editSetup(() {}),
                        decoration: const InputDecoration(
                          hintText: 'e.g. My coding assistant',
                          counterText: '',
                          isDense: true,
                        ),
                      ),
              ),
              TextButton(
                onPressed: busy
                    ? null
                    : () => editSetup(() => automaticName = !automaticName),
                child: Text(automaticName ? 'Edit' : 'Use automatic'),
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
                    ? 'Create replacement'
                    : 'Create coordinator')
              : 'Use selected session',
          submitMaster,
          primary: true,
          enabled:
              can &&
              (setupAction == 'new'
                  ? (selectedPlatform?['canCreate'] != false &&
                        (automaticName || customName.text.trim().isNotEmpty))
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
                platform = id;
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
      'Your linked WhatsApp can send tasks while this app is closed. You can turn this off at any time. Keep-awake is a separate choice.',
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
        'name': automaticName
            ? 'FarFromDesk · $platformName'
            : customName.text.trim(),
        'operationId': const Uuid().v4(),
      });
    } else {
      final s = (selectedPlatform?['sessions'] ?? []).cast<Map>().firstWhere(
        (s) => s['id'] == selectedNativeId,
      );
      if (!await confirm(
        'Use the selected session as your coordinator?',
        '${s['name']}\n${s['cwd']}\nSession: ${s['id']}\n\nThis existing session will receive WhatsApp requests. Finish any active native turn first. Native project permissions stay intact. When replacing a coordinator, its unfinished bridge requests close; native work may continue.',
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
    modalUpdate?.call(() {});
    editSetup(() => setupFormRequested = false);
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
        : 'WhatsApp request';
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
            'Closing the window keeps work running when background access is on. If the service stops, unsent requests resume when it starts again. Replies wait for WhatsApp to reconnect.\n\nFor a request needing review, check the exact native chat first. Close tracking if you already received the answer or no longer need it. Uncertain tasks are never resent automatically.',
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
                    'Requests from WhatsApp and approvals your sessions ask for will show up here once WhatsApp is connected.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 12, color: muted),
                  ),
                ),
                gap(14),
                button('Connect WhatsApp', () => go(0), primary: true),
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
                        'Every WhatsApp request, which session took it and what happened.',
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
                            : 'Send a task in your connected WhatsApp chat to get started.',
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
            stepRow('Received on WhatsApp', detail: received, state: 'done'),
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
                  ? 'Sent to WhatsApp when the session answers'
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
                  'Sent means accepted by WhatsApp. Delivery and read receipts appear only when observed; none of these proves the task succeeded.',
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
      panel(
        'On this $computer',
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            settingRow(
              'Run in the background',
              'Receive WhatsApp tasks while the window is closed. Turning this off disconnects WhatsApp and pauses forwarding.',
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
                  'Keep an operating laptop ventilated, never in a bag. Sleep prevention does not override manual sleep, lid-close sleep or low-battery protection. If this $computer sleeps or loses internet, WhatsApp cannot reach it.',
                  tag('Pauses'),
                ),
              ],
            ),
            gap(10),
            settingsDisclosure(
              icon: Icons.shield_outlined,
              title: 'Your account & permissions',
              subtitle: 'Your account, selected sessions and native approvals',
              children: [
                settingRow(
                  'Owner account',
                  '${status['whatsapp']?['phoneNumber'] ?? 'Your linked WhatsApp account'} is the only account that can send tasks.',
                  connected ? tag('Linked', good: true) : tag('Not linked'),
                ),
                settingRow(
                  'Selected sessions',
                  '${(status['bindings'] ?? []).length} sessions can receive tasks from WhatsApp. Worker reports do not grant new permissions.',
                  button(
                    'Manage',
                    () => openManage(tab: 'Connected sessions'),
                    compact: true,
                  ),
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
              subtitle: status['voice']?['ready'] == true
                  ? 'Voice notes ready'
                  : 'Choose local transcription tools',
              children: [
                gap(12),
                if (status['voice']?['download'] != null) ...[
                  voiceDownload(),
                  gap(16),
                ],
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

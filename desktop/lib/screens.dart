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

  Widget small(String text) => Text(
    text,
    style: const TextStyle(fontSize: 11, color: muted, height: 1.5),
  );
  Widget gap([double size = 18]) => SizedBox(height: size);
  Widget navTab(
    String title,
    bool selected,
    VoidCallback onTap, {
    int? count,
  }) => Material(
    color: selected ? action : surface,
    borderRadius: BorderRadius.circular(8),
    child: InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: busy ? null : onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                title,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: selected ? Colors.white : ink,
                ),
              ),
              if (count != null) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: selected
                        ? Colors.white.withValues(alpha: .15)
                        : canvas,
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: Text('$count', style: const TextStyle(fontSize: 11)),
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );
  Widget buildDesk(BuildContext context) {
    final titles = ['Home', 'Activity', 'Settings'];
    final pending = (status['pendingJobs'] ?? []).length;
    final count = pending + (status['approvals'] ?? []).length;
    final connection = connected
        ? 'Connected'
        : !ready
        ? 'Offline'
        : status['whatsapp']?['status'] == 'connecting'
        ? 'Connecting'
        : preferences['backgroundEnabled'] != true
        ? 'Paused'
        : 'Offline';
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            SizedBox(
              height: 52,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 22),
                child: Row(
                  children: [
                    Text(
                      'FarFromDesk / ${titles[section]}',
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(width: 14),
                    Container(
                      width: 6,
                      height: 6,
                      decoration: BoxDecoration(
                        color: connected ? success : muted,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      connection,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                        color: connected ? success : muted,
                      ),
                    ),
                    const Spacer(),
                    if (busy)
                      const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    IconButton(
                      tooltip: 'Refresh',
                      onPressed: busy ? null : refresh,
                      icon: const Icon(Icons.refresh, size: 18, color: muted),
                    ),
                  ],
                ),
              ),
            ),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(
                    width: 86,
                    child: Column(
                      children: [
                        const SizedBox(height: 22),
                        SizedBox(
                          width: 42,
                          height: 42,
                          child: Center(
                            child: Image.asset(
                              'assets/ffd-icon.png',
                              width: 27,
                              height: 27,
                            ),
                          ),
                        ),
                        const SizedBox(height: 22),
                        for (var i = 0; i < 3; i++)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 9),
                            child: Stack(
                              clipBehavior: Clip.none,
                              children: [
                                Material(
                                  color: section == i
                                      ? accentWash
                                      : Colors.transparent,
                                  borderRadius: BorderRadius.circular(10),
                                  child: SizedBox(
                                    width: 40,
                                    height: 40,
                                    child: IconButton(
                                      tooltip: titles[i],
                                      isSelected: section == i,
                                      style: IconButton.styleFrom(
                                        shape: RoundedRectangleBorder(
                                          borderRadius: BorderRadius.circular(
                                            10,
                                          ),
                                        ),
                                      ),
                                      onPressed: () => go(i),
                                      icon: Icon(
                                        [
                                          Icons.home_outlined,
                                          Icons.history,
                                          Icons.settings_outlined,
                                        ][i],
                                        size: 18,
                                        color: section == i ? accent : muted,
                                      ),
                                    ),
                                  ),
                                ),
                                if (i == 1 && count > 0)
                                  Positioned(
                                    right: -3,
                                    top: -3,
                                    child: Container(
                                      padding: const EdgeInsets.all(4),
                                      decoration: const BoxDecoration(
                                        color: action,
                                        shape: BoxShape.circle,
                                      ),
                                      child: Text(
                                        '$count',
                                        style: const TextStyle(
                                          fontSize: 9,
                                          color: Colors.white,
                                        ),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        const Spacer(),
                      ],
                    ),
                  ),
                  Expanded(
                    child: Column(
                      children: [
                        if (api.preview)
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 26,
                              vertical: 7,
                            ),
                            child: small(
                              'Design preview · sample data · no account is connected',
                            ),
                          ),
                        if (error != null || actionError != null)
                          Container(
                            color: sand,
                            padding: const EdgeInsets.all(16),
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
                        if (pending > 0 && section != 1)
                          Container(
                            color: sand,
                            padding: const EdgeInsets.all(16),
                            child: Row(
                              children: [
                                const Icon(
                                  Icons.schedule,
                                  color: warning,
                                  size: 18,
                                ),
                                const SizedBox(width: 12),
                                Text('$pending unfinished requests'),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: small('Waiting for a reply or review'),
                                ),
                                TextButton(
                                  onPressed: () => go(1),
                                  child: const Text('Review in Activity'),
                                ),
                              ],
                            ),
                          ),
                        Expanded(
                          child: SingleChildScrollView(
                            padding: const EdgeInsets.fromLTRB(26, 22, 26, 36),
                            child: Center(
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 960,
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                titles[section],
                                                style: Theme.of(context)
                                                    .textTheme
                                                    .headlineLarge,
                                              ),
                                              gap(7),
                                              Text(
                                                [
                                                  'Your WhatsApp connection and coding assistant.',
                                                  'See which session answered and what needs your attention.',
                                                  'Decide when FarFromDesk runs and how this $computer stays available.',
                                                ][section],
                                                style: const TextStyle(
                                                  fontSize: 13,
                                                  color: muted,
                                                  height: 1.5,
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                        if (section == 0 && ready)
                                          button(
                                            connected
                                                ? 'Refresh connection'
                                                : status['whatsapp']?['qr'] !=
                                                      null
                                                ? 'Check connection'
                                                : 'Connect WhatsApp',
                                            connected ? refresh : connectPhone,
                                            primary: !connected,
                                          ),
                                      ],
                                    ),
                                    gap(),
                                    if (!ready) ...[
                                      if (error == null)
                                        const Center(
                                          child: CircularProgressIndicator(),
                                        )
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
                          ),
                        ),
                      ],
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

  Widget pairingStep(String number, String title, String detail) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Container(
        width: 25,
        height: 25,
        decoration: const BoxDecoration(
          color: accentWash,
          shape: BoxShape.circle,
        ),
        alignment: Alignment.center,
        child: Text(
          number,
          style: const TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: accent,
          ),
        ),
      ),
      const SizedBox(width: 11),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            ),
            gap(5),
            small(detail),
          ],
        ),
      ),
    ],
  );
  Widget card(Widget child) => Container(
    margin: const EdgeInsets.only(bottom: 18),
    padding: const EdgeInsets.all(24),
    decoration: BoxDecoration(
      color: panelColor,
      borderRadius: BorderRadius.circular(24),
    ),
    child: Material(color: Colors.transparent, child: child),
  );
  List<Widget> homeScreen() {
    final wa = status['whatsapp'] ?? {},
        master = status['master'],
        voice = status['voice']?['ready'] == true;
    return [
      if (connected)
        card(
          Row(
            children: [
              const SizedBox(
                width: 48,
                height: 48,
                child: Icon(
                  Icons.mark_chat_read_outlined,
                  size: 26,
                  color: success,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      wa['phoneNumber'] ?? 'Your WhatsApp account',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    gap(5),
                    const Text(
                      'Linked WhatsApp account · Only this account can control FarFromDesk.',
                      style: TextStyle(color: muted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 16),
              tag('Connected', good: true),
              const SizedBox(width: 14),
              button('Log out…', logout),
            ],
          ),
        )
      else
        panel(
          'Pair your phone',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  if (wa['qr'] is String)
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Image.memory(
                        base64Decode((wa['qr'] as String).split(',').last),
                        width: 216,
                        height: 216,
                        semanticLabel: 'WhatsApp pairing QR code',
                      ),
                    )
                  else
                    Container(
                      width: 240,
                      height: 240,
                      decoration: BoxDecoration(
                        color: accentWash,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const Icon(Icons.qr_code, size: 60, color: accent),
                          gap(14),
                          if (wa['status'] == 'connecting')
                            const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 20),
                            child: Text(
                              wa['status'] == 'connecting'
                                  ? 'Preparing your connection…'
                                  : 'Connect to generate your QR code',
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 11,
                                color: muted,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  const SizedBox(width: 30),
                  Expanded(
                    child: Column(
                      children: [
                        pairingStep(
                          '1',
                          'Open WhatsApp',
                          'Use the account you want to connect.',
                        ),
                        gap(22),
                        pairingStep(
                          '2',
                          'Open Linked devices',
                          'Find it in WhatsApp Settings.',
                        ),
                        gap(22),
                        pairingStep(
                          '3',
                          'Link a device',
                          'Scan the QR code shown here.',
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              if (preferences['backgroundEnabled'] != true) ...[
                gap(),
                small(
                  'Connecting will ask for background access first. No system sleep settings will change.',
                ),
              ],
            ],
          ),
          trailing: small('A one-time setup'),
        ),
      if (connected) destinationCard(),
      card(
        master != null
            ? assistantSummary(master)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  masterForm(),
                  gap(),
                  masterActions(),
                  ...setupOperation(),
                ],
              ),
      ),
      if (wa['error'] != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 18),
          child: Text(wa['error'], style: const TextStyle(color: warning)),
        ),
      Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: panelColor,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: (voice ? success : warning).withValues(alpha: .35),
          ),
        ),
        child: Row(
          children: [
            Icon(
              voice ? Icons.graphic_eq : Icons.mic_off_outlined,
              color: voice ? success : warning,
              size: 25,
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    voice ? 'Voice notes ready' : 'Voice notes unavailable',
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  gap(5),
                  Text(
                    voice
                        ? 'Send a voice note in your connected chat. Audio is processed locally on this $computer.'
                        : 'Configure local speech tools in Settings to enable voice notes.',
                    style: const TextStyle(fontSize: 12, color: muted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 18),
        child: Row(
          children: [
            const Icon(Icons.shield_outlined, color: accent, size: 17),
            const SizedBox(width: 12),
            Expanded(
              child: small(
                'Pause forwarding in Settings, or use Log out above to unlink this device.',
              ),
            ),
          ],
        ),
      ),
    ];
  }

  Future<void> logout() async {
    if (await confirm(
      'Log out of WhatsApp?',
      'Unlink this device and pause forwarding and keep-awake. Your master, selected sessions and request history are kept. Work already running in native apps may continue.',
    )) {
      await post('/api/logout', {'confirmed': true});
    }
  }

  Widget destinationChoice(
    String title,
    String detail,
    IconData icon,
    bool selected,
    VoidCallback tap,
  ) => Expanded(
    child: Material(
      color: selected ? action : canvas,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: busy ? null : tap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: selected ? action : line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(icon, size: 22, color: selected ? Colors.white : muted),
                  const Spacer(),
                  Icon(
                    selected ? Icons.check_circle : Icons.circle_outlined,
                    size: 17,
                    color: selected ? Colors.white : line,
                  ),
                ],
              ),
              gap(12),
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              gap(5),
              Text(
                detail,
                style: TextStyle(
                  fontSize: 11,
                  color: selected ? Colors.white : muted,
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
  Widget destinationCard() => panel(
    'Where should replies appear?',
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            destinationChoice(
              'Message yourself',
              'Use your existing personal chat.',
              Icons.account_circle_outlined,
              !showGroups,
              () {
                changeView(() => showGroups = false);
                post('/api/destination');
              },
            ),
            const SizedBox(width: 14),
            destinationChoice(
              'Private group',
              'Choose a group or set one up.',
              Icons.people_outline,
              showGroups,
              () {
                changeView(() => showGroups = true);
                loadGroups();
              },
            ),
          ],
        ),
        if (showGroups) ...[
          const Divider(),
          if (status['destination']?['kind'] != 'group') ...[
            const Text(
              'Choose a group below to switch replies. For now, replies still go to Message yourself.',
            ),
            gap(),
          ],
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Your bridge groups',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              button('Refresh groups', loadGroups, icon: Icons.refresh),
            ],
          ),
          gap(),
          if (loadingGroups)
            const LinearProgressIndicator()
          else if (groups.isEmpty) ...[
            small('No existing owner-only bridge group was found.'),
            gap(),
            button('Set up a private group…', createGroup),
          ] else
            for (final group in groups)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Row(
                  children: [
                    const Icon(Icons.people, color: accent, size: 20),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            group['name'],
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          small('Saved group · membership checked when used'),
                        ],
                      ),
                    ),
                    if (status['destination']?['jid'] == group['id'])
                      tag('In use', good: true)
                    else
                      button(
                        'Use this group',
                        () => post('/api/destination', {'jid': group['id']}),
                        primary: true,
                      ),
                  ],
                ),
              ),
          gap(),
          small(
            'Switching chats keeps your master and selected sessions. Pending replies retain their original destination. Group forwarding pauses if another participant is detected.',
          ),
        ],
      ],
    ),
    trailing: small(
      'Current: ${status['destination']?['name'] ?? 'Message yourself'}',
    ),
  );
  Future<void> loadGroups() async {
    changeView(() => loadingGroups = true);
    await act(() async {
      final d = await api.get('/api/group-recover');
      groups = List<Map>.from(d['groups'] ?? []);
    });
    if (mounted) changeView(() => loadingGroups = false);
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

  Widget assistantSummary(dynamic master) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: accentWash,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              master['provider'] == 'claude'
                  ? Icons.star_rate_rounded
                  : Icons.terminal,
              color: master['provider'] == 'claude'
                  ? const Color(0xffd9a69f)
                  : accent,
              size: 25,
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  master['name'],
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                gap(5),
                small(
                  '${master['provider'] == 'claude' ? 'Claude' : 'Codex'} · ${master['executionMode'] == 'desktop' ? 'Desktop' : 'CLI'}',
                ),
              ],
            ),
          ),
          tag(
            preferences['backgroundEnabled'] != true
                ? 'Paused'
                : !connected
                ? 'Waiting'
                : 'Ready',
            good: connected && preferences['backgroundEnabled'] == true,
          ),
          PopupMenuButton<String>(
            tooltip: 'Master chat options',
            icon: const Icon(Icons.more_horiz, size: 20, color: accent),
            onSelected: (value) {
              if (value == 'sessions') {
                browse();
              } else {
                showInstructions();
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(
                value: 'instructions',
                child: Text('View instructions'),
              ),
              const PopupMenuItem(
                value: 'sessions',
                child: Text('Connected sessions'),
              ),
            ],
          ),
        ],
      ),
      gap(20),
      Row(
        children: [
          const Expanded(
            child: Text(
              'Handles your WhatsApp requests and coordinates other sessions.',
              style: TextStyle(color: muted),
            ),
          ),
          const SizedBox(width: 20),
          button(
            'Change platform or master',
            openMaster,
            primary: true,
            icon: Icons.sync,
          ),
        ],
      ),
      ...setupOperation(),
    ],
  );
  Future<void> showInstructions() async {
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Coordinator instructions'),
        content: SizedBox(
          width: 560,
          height: 360,
          child: SingleChildScrollView(
            child: SelectableText(
              status['masterSetup']?['prompt'] ?? 'Instructions unavailable.',
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
        Row(
          children: [
            const Text('App'),
            const Spacer(),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: line.withValues(alpha: .65),
                borderRadius: BorderRadius.circular(6),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: platform,
                  dropdownColor: surface,
                  isDense: true,
                  style: const TextStyle(
                    fontFamily: 'DMSans',
                    fontSize: 13,
                    color: ink,
                    fontWeight: FontWeight.w600,
                  ),
                  items: [
                    for (final p in platforms)
                      DropdownMenuItem(
                        value: '${p['provider']}:${p['executionMode']}',
                        child: Text(
                          '${p['provider'] == 'claude' ? 'Claude' : 'Codex'} ${p['executionMode'] == 'desktop' ? 'Desktop' : 'CLI'}',
                        ),
                      ),
                  ],
                  onChanged: busy
                      ? null
                      : (value) {
                          if (value != null) {
                            editSetup(() {
                              platform = value;
                              selectedNativeId = '';
                              visibleSessions = 30;
                              search.clear();
                            });
                          }
                        },
                ),
              ),
            ),
          ],
        ),
        gap(14),
        Container(
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: canvas,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            children: [
              Expanded(
                child: navTab(
                  'Create new session',
                  setupAction == 'new',
                  () => editSetup(() => setupAction = 'new'),
                ),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: navTab(
                  'Use existing session',
                  setupAction == 'existing',
                  () => editSetup(() => setupAction = 'existing'),
                ),
              ),
            ],
          ),
        ),
        gap(14),
        if (setupAction == 'new') ...[
          Row(
            children: [
              const Text(
                'Session name',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
              ),
              const Spacer(),
              const Text('Automatic'),
              const SizedBox(width: 8),
              SizedBox(
                height: 26,
                child: Switch(
                  value: automaticName,
                  onChanged: busy
                      ? null
                      : (v) => editSetup(() => automaticName = v),
                ),
              ),
            ],
          ),
          gap(10),
          if (automaticName)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: canvas,
                borderRadius: BorderRadius.circular(9),
              ),
              child: Text('FarFromDesk · $platformName'),
            )
          else
            TextField(
              controller: customName,
              maxLength: 80,
              onChanged: (_) => editSetup(() {}),
              decoration: const InputDecoration(
                hintText: 'e.g. My coding assistant',
              ),
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
                                    ? 'Can resume'
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
                ? 'Select a session to use as your master.'
                : 'Finish active native turns before resuming this exact conversation.',
          ),
          gap(8),
          small(
            'Saved CLI chats can receive requests. This does not verify account limits or successful execution.',
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
        status['masterSetup']?['operation']?['status'] != 'creating';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Spacer(),
            button(
              setupAction == 'new'
                  ? (status['master'] == null
                        ? 'Create master'
                        : 'Create replacement')
                  : (status['master'] == null
                        ? 'Use selected session'
                        : 'Use as master'),
              submitMaster,
              primary: true,
              enabled:
                  can &&
                  (setupAction == 'new'
                      ? (automaticName || customName.text.trim().isNotEmpty)
                      : existing),
            ),
          ],
        ),
        gap(10),
        small(
          status['master'] == null
              ? 'Your chosen app’s sign-in and permissions apply.'
              : 'Switches only after setup succeeds. Previous master requests will then close.',
        ),
      ],
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
        'sessionId': selectedNativeId,
        'operationId': const Uuid().v4(),
      });
    }
    modalUpdate?.call(() {});
  }

  Future<void> openMaster() async {
    editSetup(() {
      platform =
          '${status['master']['provider']}:${status['master']['executionMode']}';
      setupAction = 'existing';
      selectedNativeId = '';
      search.clear();
      visibleSessions = 30;
    });
    await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) {
          modalUpdate = update;
          return Dialog(
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: setupAction == 'existing' ? 620 : 540,
                maxHeight: MediaQuery.sizeOf(context).height - 70,
              ),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            setupAction == 'new'
                                ? 'Create a master chat'
                                : 'Choose an existing session',
                            style: const TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        IconButton(
                          tooltip: 'Close',
                          onPressed: () => Navigator.pop(context),
                          icon: const Icon(Icons.close, size: 16),
                        ),
                      ],
                    ),
                    gap(8),
                    const Text(
                      'Your current master stays active until this one is ready.',
                      style: TextStyle(color: muted),
                    ),
                    gap(20),
                    Flexible(
                      child: SingleChildScrollView(
                        child: Column(
                          children: [masterForm(), ...setupOperation()],
                        ),
                      ),
                    ),
                    const Divider(),
                    masterActions(),
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
    'Needs review' => ['uncertain', 'failed'].contains(job['status']),
    'Answered' => job['status'] == 'completed',
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
  List<Widget> activityScreen() {
    final jobs = allJobs.where((j) => includeJob(j, activityFilter)).toList();
    return [
      panel(
        'Requests are saved on this $computer',
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Closing the window keeps work running when background access is on. If the service stops, unsent requests resume when it runs again; uncertain deliveries stay here for review. Recorded replies wait for WhatsApp to reconnect.',
              style: TextStyle(color: muted),
            ),
            gap(),
            const Text(
              'For Awaiting reply or Needs review: check the exact native chat below. If you already received the answer, or no longer need a reply, close the request after review. To continue interrupted work, send a new message after checking what already ran.',
            ),
            if (preferences['backgroundEnabled'] != true) ...[
              gap(),
              button('Open background settings', () => go(2)),
            ],
          ],
        ),
        trailing: small('${(status['pendingJobs'] ?? []).length} unfinished'),
      ),
      for (final a in status['approvals'] ?? [])
        panel(
          '${a['alias']} needs your input',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SelectableText(a['question']),
              gap(),
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
                    }),
                ],
              ),
            ],
          ),
        ),
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Request history',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w500),
                  ),
                  gap(5),
                  small('Unfinished first · then recent replies'),
                ],
              ),
            ),
            small('${allJobs.length} requests'),
          ],
        ),
      ),
      Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final filter in [
            'All',
            'Waiting',
            'Needs review',
            'Answered',
            'Closed',
          ])
            navTab(
              filter,
              activityFilter == filter,
              () => changeView(() => activityFilter = filter),
              count: allJobs.where((j) => includeJob(j, filter)).length,
            ),
        ],
      ),
      gap(16),
      Row(
        children: [
          button(
            'Select eligible',
            () => changeView(() {
              chosen.clear();
              chosen.addAll(
                jobs
                    .where((j) => j['canClose'] == true)
                    .take(500)
                    .map((j) => j['id'] as String),
              );
            }),
          ),
          if (chosen.isNotEmpty) ...[
            const SizedBox(width: 10),
            button('Clear selection', () => changeView(chosen.clear)),
          ],
          const Spacer(),
          button(
            'Close selected (${chosen.length})…',
            bulkClose,
            enabled: chosen.isNotEmpty,
          ),
        ],
      ),
      gap(14),
      small(
        'Select requests awaiting a reply or review. Known active deliveries, permissions and unfinished delegated work are protected.',
      ),
      gap(10),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        child: Row(
          children: [
            const SizedBox(width: 38),
            Expanded(child: small('Session')),
            SizedBox(width: 112, child: small('Received')),
            SizedBox(width: 146, child: small('Status')),
            const SizedBox(width: 20),
          ],
        ),
      ),
      if (jobs.isEmpty)
        Padding(
          padding: const EdgeInsets.all(22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.inbox_outlined, color: accent, size: 24),
              gap(13),
              Text(
                activityFilter == 'All'
                    ? 'No requests yet'
                    : 'No matching requests',
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                ),
              ),
              gap(10),
              small(
                activityFilter == 'All'
                    ? 'Send a task in your connected WhatsApp chat to get started.'
                    : 'There are no requests in this category in the loaded history.',
              ),
            ],
          ),
        ),
      for (final j in jobs) activityRow(j),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 16),
        child: Row(
          children: [
            small(
              'Showing ${jobs.length} of ${allJobs.length} loaded requests',
            ),
            const Spacer(),
            small('All unfinished + latest 100'),
          ],
        ),
      ),
    ];
  }

  Widget activityRow(Map job) {
    final binding = List<Map>.from(status['bindings'] ?? [])
        .where((b) => b['id'] == job['binding_id'])
        .firstOrNull;
    final review = ['uncertain', 'failed'].contains(job['status']);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 38,
            child: Checkbox(
              value: chosen.contains(job['id']),
              onChanged: job['canClose'] == true
                  ? (v) => changeView(() {
                      if (v == true) {
                        chosen.add(job['id']);
                      } else {
                        chosen.remove(job['id']);
                      }
                    })
                  : null,
            ),
          ),
          Expanded(
            child: Material(
              color: panelColor,
              borderRadius: BorderRadius.circular(12),
              child: Theme(
                data: Theme.of(context)
                    .copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  tilePadding: const EdgeInsets.symmetric(horizontal: 16),
                  childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  title: Row(
                    children: [
                      Expanded(
                        child: Text(
                          binding?['name'] ??
                              binding?['alias'] ??
                              'Coding session',
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      SizedBox(
                        width: 112,
                        child: small(
                          DateTime.fromMillisecondsSinceEpoch(job['created_at'])
                              .toLocal()
                              .toString()
                              .substring(5, 16),
                        ),
                      ),
                      SizedBox(
                        width: 146,
                        child: Text(
                          jobLabel(job['status']),
                          style: TextStyle(
                            fontSize: 11,
                            color: review
                                ? warning
                                : job['status'] == 'completed'
                                ? success
                                : muted,
                          ),
                        ),
                      ),
                    ],
                  ),
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: SelectableText(
                        'Request: ${job['id']}\nSession: ${binding?['native_id'] ?? 'Unknown'}\nProject: ${binding?['cwd'] ?? 'Unavailable'}',
                        style: const TextStyle(fontSize: 12, color: muted),
                      ),
                    ),
                    gap(12),
                    if (job['error'] != null)
                      Text(
                        job['error'],
                        style: const TextStyle(color: warning),
                      ),
                    if (review)
                      const Text(
                        'Delivery or completion could not be confirmed. Check the native chat before sending anything again. This request will not be resent automatically.',
                      ),
                    gap(12),
                    Wrap(
                      spacing: 10,
                      children: [
                        if (job['canClose'] == true)
                          button('Close after review…', () async {
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
                          }),
                        if (![
                          'reviewed',
                          'replaced',
                          'auto_closed',
                          'completed',
                        ].contains(job['status']))
                          button('Send reviewed document', () => document(job)),
                      ],
                    ),
                  ],
                ),
              ),
            ),
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

  Widget settingRow(
    IconData icon,
    String title,
    String detail,
    Widget control,
  ) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      children: [
        SizedBox(width: 28, child: Icon(icon, size: 19, color: accent)),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                ),
              ),
              gap(6),
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
              Icons.app_registration_outlined,
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
            const Divider(),
            settingRow(
              Icons.power_settings_new,
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
            const Divider(),
            settingRow(
              Icons.bedtime_outlined,
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
        'Coding apps',
        Column(
          children: [
            for (final provider in ['codex', 'claude']) ...[
              if (provider == 'claude') const Divider(),
              settingRow(
                provider == 'codex' ? Icons.terminal : Icons.star_rate_rounded,
                provider == 'codex' ? 'Codex' : 'Claude',
                platforms.any(
                      (p) =>
                          p['provider'] == provider && p['available'] == true,
                    )
                    ? 'Native CLI available'
                    : 'Native CLI unavailable · install and sign in first',
                Switch(
                  value: (status['apps'] ?? []).any(
                    (a) => a['provider'] == provider && a['enabled'] == true,
                  ),
                  onChanged:
                      busy ||
                          !platforms.any(
                            (p) =>
                                p['provider'] == provider &&
                                p['available'] == true,
                          )
                      ? null
                      : (v) {
                          final enabled = (status['apps'] ?? [])
                              .where((a) => a['enabled'] == true)
                              .map((a) => a['provider'])
                              .toSet();
                          v ? enabled.add(provider) : enabled.remove(provider);
                          post('/api/apps', {'enabled': enabled.toList()});
                        },
                ),
              ),
            ],
          ],
        ),
      ),
      panel(
        'Request cleanup',
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            settingRow(
              Icons.history_toggle_off,
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
                DropdownButton<int>(
                  value: [24, 72, 168].contains(cleanup['afterHours'])
                      ? cleanup['afterHours']
                      : 24,
                  items: const [
                    DropdownMenuItem(value: 24, child: Text('24 hours')),
                    DropdownMenuItem(value: 72, child: Text('3 days')),
                    DropdownMenuItem(value: 168, child: Text('7 days')),
                  ],
                  onChanged: busy
                      ? null
                      : (hours) {
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
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              leading: const Icon(Icons.laptop_mac, color: accent, size: 19),
              title: const Text(
                'Lid closed · OS requirements apply',
                style: TextStyle(fontSize: 14),
              ),
              subtitle: small(
                'Keep-awake cannot override every sleep condition',
              ),
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: small(
                    'Keep an operating laptop ventilated, never in a bag. Sleep prevention does not override manual sleep or low-battery protection. If this $computer sleeps or loses internet, WhatsApp cannot wake or reach it. Use your operating system’s supported external-display setup.',
                  ),
                ),
              ],
            ),
            const Divider(),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              leading: const Icon(
                Icons.shield_outlined,
                color: accent,
                size: 19,
              ),
              title: const Text(
                'Privacy & agent permissions',
                style: TextStyle(fontSize: 14),
              ),
              subtitle: small(
                'Your account, selected sessions and native approvals',
              ),
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: small(
                    'Only your linked WhatsApp account can control the bridge. Your master coordinates selected sessions; worker reports do not grant new permissions. Native agent approval rules still apply. Pausing the bridge does not stop work already running in an agent. Your local admin credential is never sent to a model.',
                  ),
                ),
              ],
            ),
            const Divider(),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              leading: const Icon(Icons.graphic_eq, color: accent, size: 19),
              title: const Text(
                'Local voice tools',
                style: TextStyle(fontSize: 14),
              ),
              subtitle: small(
                status['voice']?['ready'] == true
                    ? 'Voice notes ready'
                    : 'Configure FFmpeg, whisper-cli and a local model',
              ),
              children: [
                gap(12),
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
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        child: Row(
          children: [
            Image.asset('assets/ffd-icon.png', width: 28, height: 28),
            const SizedBox(width: 14),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'FarFromDesk',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                ),
                gap(5),
                small('Version 0.7.0 · Shared desktop preview'),
              ],
            ),
            const Spacer(),
            Expanded(
              child: Text(
                'This $computer and your agent provider must be online.\nQueued replies are retained during outages.',
                textAlign: TextAlign.right,
                style: const TextStyle(fontSize: 11, color: muted),
              ),
            ),
          ],
        ),
      ),
    ];
  }
}

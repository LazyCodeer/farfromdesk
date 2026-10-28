part of 'app.dart';

/// Inbox, Items and Settings from the FarFromDesk Studio design. Each fills
/// the content area instead of scrolling as one long column.
extension _Panes on _DeskState {
  Widget? paneScreen() => switch (section) {
    1
        when connected ||
            allJobs.isNotEmpty ||
            (status['approvals'] ?? []).isNotEmpty ||
            (status['commandTurns'] ?? []).isNotEmpty ||
            (status['voiceRequests'] ?? []).isNotEmpty =>
      inboxPane(),
    2 => itemsBoard(),
    4 => settingsPane(),
    _ => null,
  };

  // One list row per saved session; request actions stay within its thread.
  bool needsReview(Map j) =>
      !['reviewed', 'replaced', 'auto_closed'].contains(j['status']) &&
      (['uncertain', 'failed'].contains(j['status']) ||
          j['outcome'] == 'blocked');

  String sessionKey(Map j) =>
      '${j['binding_id'] ?? j['master_id'] ?? status['master']?['id'] ?? 'unassigned'}';
  Map? sessionBinding(String id) =>
      List<Map>.from(status['bindings'] ?? [])
          .where((b) => b['id'] == id)
          .firstOrNull;
  String jobSession(Map j) =>
      '${sessionBinding(sessionKey(j))?['name'] ?? sessionBinding(sessionKey(j))?['alias'] ?? 'Coding session'}';
  String sessionApp(String id) {
    final b = sessionBinding(id);
    if (b == null) return 'Not routed to a session';
    return '${b['provider'] == 'claude' ? 'Claude' : 'Codex'} ${b['executionMode'] == 'desktop' ? 'Desktop' : 'CLI'}';
  }

  String inboxText(dynamic value) {
    var text = '${value ?? ''}'.trim();
    if (text.startsWith('Worker report for owner request ')) {
      final end = text.indexOf('\n\n');
      text = end < 0 ? 'Worker report' : text.substring(end + 2);
    }
    text = text.replaceFirst(
      RegExp(r'^\*(?:Session: |#\d+ · )[^\n]+\*\n\n'),
      '',
    );
    text = text.replaceFirst(
      RegExp(r'^(?:💬|ℹ️|📝) \*(?:Reply|Notice|Update)\*\n'),
      '',
    );
    return text
        .replaceFirst(RegExp(r'\n\n— FarFromDesk(?: · [^\n]*)?$'), '')
        .trim();
  }

  List<Map> sessionGroups() {
    // Preview/older backends retain the same grouping without invented replies.
    final grouped = <String, List<Map>>{};
    for (final j in allJobs) {
      (grouped[sessionKey(j)] ??= []).add(j);
    }
    final groups =
        inboxGroups ??
        [
          for (final entry in grouped.entries)
            {
              'id': entry.key,
              'binding_id': entry.key,
              'name': jobSession(entry.value.first),
              'requestCount': entry.value.length,
              'latestAt': entry.value
                  .map((j) => (j['updated_at'] ?? j['created_at'] ?? 0) as num)
                  .reduce((a, b) => a > b ? a : b),
              'preview': (List<Map>.from(
                entry.value,
              )..sort((a, b) => jobAt(b).compareTo(jobAt(a)))).first['preview'],
              'needsReview': entry.value.where(needsReview).length,
              'waiting': entry.value
                  .where((j) => includeJob(j, 'Waiting'))
                  .length,
              'answered': entry.value
                  .where((j) => includeJob(j, 'Answered'))
                  .length,
              'closed': entry.value
                  .where((j) => includeJob(j, 'Closed'))
                  .length,
            },
        ];
    final query = activityQuery.trim().toLowerCase();
    final shown = groups
        .where((g) {
          final filter = switch (activityFilter) {
            'Waiting' => 'waiting',
            'Needs review' => 'needsReview',
            'Answered' => 'answered',
            'Closed' => 'closed',
            _ => null,
          };
          if (inboxTab == 'Requests' &&
              filter != null &&
              (g[filter] as num? ?? 0) == 0) {
            return false;
          }
          return inboxTab != 'Requests' ||
              inboxGroups != null ||
              query.isEmpty ||
              '${g['name']} ${g['preview']} ${grouped[g['id']]?.map((j) => j['preview']).join(' ')}'
                  .toLowerCase()
                  .contains(query);
        })
        .map((g) => Map.of(g))
        .toList();
    for (final g in shown) {
      g['waitingForYou'] = List<Map>.from(status['approvals'] ?? [])
          .where((a) => a['alias'] == sessionBinding('${g['id']}')?['alias'])
          .length;
    }
    shown.sort((a, b) {
      final aNeeds =
          (a['needsReview'] as num? ?? 0) + (a['waitingForYou'] as num? ?? 0) >
          0;
      final bNeeds =
          (b['needsReview'] as num? ?? 0) + (b['waitingForYou'] as num? ?? 0) >
          0;
      if (aNeeds != bNeeds) return aNeeds ? -1 : 1;
      return (b['latestAt'] as num).compareTo(a['latestAt'] as num);
    });
    return shown;
  }

  Future<void> loadInbox() async {
    if (inboxLoading) return;
    inboxLoading = true;
    final epoch = inboxEpoch;
    try {
      final data = await api.get(
        '/api/inbox-thread?q=${Uri.encodeComponent(inboxTab == 'Requests' ? activityQuery : '')}',
      );
      if (!mounted || epoch != inboxEpoch) return;
      changeView(() {
        if (data['sessions'] is List) {
          inboxGroups = List<Map>.from(data['sessions']);
        }
        if (data['attention'] is List) {
          inboxAttention = List<Map>.from(data['attention']);
        }
        inboxError = null;
      });
      final groups = sessionGroups();
      final id =
          groups.where((g) => g['id'] == inboxSelected).firstOrNull?['id'] ??
          groups.firstOrNull?['id'];
      if (id != null) await loadInboxThread('$id');
    } catch (e) {
      if (mounted && epoch == inboxEpoch) {
        changeView(() => inboxError = clean(e));
      }
    } finally {
      inboxLoading = false;
    }
  }

  Future<void> loadInboxThread(String id, {bool older = false}) async {
    if (older && inboxOlderLoading) return;
    if (older) changeView(() => inboxOlderLoading = true);
    final next = older ? (inboxThreads[id]?['next'] as Map?) : null;
    final scroll = inboxScrolls[id];
    final previousOffset = scroll?.hasClients == true ? scroll!.offset : 0.0;
    final previousExtent = scroll?.hasClients == true
        ? scroll!.position.maxScrollExtent
        : 0.0;
    final followLatest = previousExtent - previousOffset < 80;

    try {
      final data = await api.get(
        '/api/inbox-thread?bindingId=${Uri.encodeComponent(id)}${next == null ? '' : '&beforeAt=${next['at']}&beforeId=${Uri.encodeComponent('${next['id']}')}'}',
      );
      if (!mounted || data['messages'] is! List) return;
      final previous = inboxThreads[id];
      final previousMessages = List<Map>.from(previous?['messages'] ?? []);
      final incoming = List<Map>.from(data['messages']);
      final gapInHistory =
          previousMessages.isNotEmpty &&
          incoming.isNotEmpty &&
          ((incoming.first['at'] as num) >
                  (previousMessages.last['at'] as num) ||
              (incoming.first['at'] == previousMessages.last['at'] &&
                  '${incoming.first['key']}'.compareTo(
                        '${previousMessages.last['key']}',
                      ) >
                      0)) &&
          data['next'] != null;

      final messages =
          <String, Map>{
            for (final m in List<Map>.from(previous?['messages'] ?? []))
              '${m['key']}': m,
            for (final m in List<Map>.from(data['messages'])) '${m['key']}': m,
          }.values.toList()..sort((a, b) {
            final order = (a['at'] as num).compareTo(b['at'] as num);
            return order != 0 ? order : '${a['key']}'.compareTo('${b['key']}');
          });
      final jobs = <String, Map>{
        for (final j in List<Map>.from(previous?['jobs'] ?? []))
          '${j['id']}': j,
        for (final j in List<Map>.from(data['jobs'] ?? [])) '${j['id']}': j,
      };
      changeView(
        () => inboxThreads[id] = {
          ...data, 'messages': messages, 'jobs': jobs.values.toList(),
          // A refresh of the newest page must not reset an older page's cursor.
          'next': older || previous == null || gapInHistory
              ? data['next']
              : previous['next'],
        },
      );
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final controller = inboxScrolls[id];
        if (!mounted || controller?.hasClients != true) return;
        if (older) {
          controller!.jumpTo(
            (previousOffset +
                    controller.position.maxScrollExtent -
                    previousExtent)
                .clamp(0.0, controller.position.maxScrollExtent),
          );
        } else if (previous == null || followLatest) {
          controller!.jumpTo(controller.position.maxScrollExtent);
        }
      });
    } catch (e) {
      if (mounted) changeView(() => inboxError = clean(e));
    } finally {
      if (mounted && older) changeView(() => inboxOlderLoading = false);
    }
  }

  void selectInboxSession(String id) {
    changeView(() {
      inboxSelected = id;
      inboxRequestSelected = null;
      inboxShowThread = true;
      inboxError = null;
    });
    unawaited(loadInboxThread(id));
  }

  List<Map> commandRows() =>
      List<Map>.from(status['commandTurns'] ?? [])
          .where(
            (c) => '${c['label']} ${c['summary']}'.toLowerCase().contains(
              activityQuery.trim().toLowerCase(),
            ),
          )
          .toList()
        ..sort(
          (a, b) => (b['created_at'] as num).compareTo(a['created_at'] as num),
        );
  String commandSummary(Map c) => inboxText(c['summary']).replaceAll('*', '');
  List<Map> attentionRows({bool search = true}) {
    final rows = <Map>[
      for (final j in allJobs.where(needsReview))
        {
          'id': 'request:${j['id']}',
          'bindingId': sessionKey(j),
          'requestId': j['id'],
          'title': 'Needs review · ${jobSession(j)}',
          'text': inboxText(j['error'] ?? j['preview']),
          'at': j['updated_at'] ?? jobAt(j),
        },
      for (final v in List<Map>.from(status['voiceRequests'] ?? []).where(
        (v) =>
            ['failed', 'routing_blocked', 'interrupted'].contains(v['status']),
      ))
        {
          'id': 'voice:${v['id']}',
          'bindingId':
              allJobs
                  .where((j) => j['id'] == v['id'])
                  .firstOrNull?['binding_id'] ??
              'unassigned-voice',
          'requestId': v['id'],
          'title': v['status'] == 'routing_blocked'
              ? 'Voice note · routing blocked'
              : 'Voice note failed',
          'text': 'Open the recorded timing and cause.',
          'at': v['created_at'],
        },
      ...inboxAttention,
      for (final c in List<Map>.from(
        status['commandTurns'] ?? [],
      ).where((c) => c['status'] == 'blocked'))
        {
          'id': 'command:${c['id']}',
          'commandId': c['id'],
          'title': '${c['label']} · Failed',
          'text': commandSummary(c),
          'at': c['created_at'],
        },
      for (final a in List<Map>.from(status['approvals'] ?? []))
        {
          'id': 'approval:${a['code']}',
          'approval': a,
          'title': 'Waiting for you · ${a['alias']}',
          'text': a['question'],
          'at': a['expires'],
        },
      for (final u in List<Map>.from(status['unlinkedUpdates'] ?? []))
        {
          'id': 'update:${u['id']}',
          'updateId': u['id'],
          'title': 'Local update needs review',
          'text':
              sessionBinding('${u['binding_id']}')?['name'] ??
              'Native session update',
          'at': u['at'],
        },
    ];
    final unique =
        {for (final r in rows) '${r['id']}': r}.values
            .where(
              (r) =>
                  !search ||
                  '${r['title']} ${r['text']}'.toLowerCase().contains(
                    activityQuery.trim().toLowerCase(),
                  ),
            )
            .toList()
          ..sort(
            (a, b) => ((b['at'] ?? 0) as num).compareTo((a['at'] ?? 0) as num),
          );
    return unique;
  }

  Widget inboxPane() {
    final groups = sessionGroups();
    final group =
        groups.where((g) => g['id'] == inboxSelected).firstOrNull ??
        groups.firstOrNull;
    final commands = commandRows();
    final command =
        commands.where((c) => c['id'] == inboxCommandSelected).firstOrNull ??
        commands.firstOrNull;
    return LayoutBuilder(
      builder: (context, box) {
        final narrow = box.maxWidth < 700;
        final hasDetail = inboxTab == 'Commands'
            ? command != null
            : group != null;
        final showDetail = !narrow || (inboxShowThread && hasDetail);
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!narrow || !showDetail)
              SizedBox(
                width: narrow ? box.maxWidth : 300,
                child: inboxList(groups, group),
              ),
            if (showDetail)
              Expanded(
                child: inboxTab == 'Commands'
                    ? command == null
                          ? Center(child: small('No matching commands.'))
                          : inboxCommandDetail(command, narrow: narrow)
                    : group == null
                    ? Center(
                        child: small(
                          'Choose a session to read its conversation.',
                        ),
                      )
                    : inboxConversation(group, narrow: narrow),
              ),
            if (group != null && inboxTab != 'Commands' && box.maxWidth >= 1180)
              SizedBox(width: 270, child: inboxSessionInfo(group)),
          ],
        );
      },
    );
  }

  Widget inboxList(List<Map> groups, Map? current) {
    final attention = attentionRows();
    final count = attentionRows(search: false).length;
    return Container(
      decoration: const BoxDecoration(
        border: Border(right: BorderSide(color: hairline)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 16, 14, 12),
            child: Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text(
                      'Inbox',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (inboxTab == 'Requests')
                      PopupMenuButton<String>(
                        key: const ValueKey('activity-filter-group'),
                        tooltip: 'Show sessions',
                        initialValue: activityFilter,
                        onSelected: (value) {
                          changeView(() => activityFilter = value);
                          unawaited(loadInbox());
                        },
                        itemBuilder: (_) => [
                          for (final f in [
                            'All',
                            'Waiting',
                            'Needs review',
                            'Answered',
                            'Closed',
                          ])
                            PopupMenuItem(
                              value: f,
                              child: Text(
                                f,
                                style: const TextStyle(fontSize: 13),
                              ),
                            ),
                        ],
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 9,
                            vertical: 5,
                          ),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: line2),
                          ),
                          child: Row(
                            children: [
                              Text(
                                activityFilter,
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: muted,
                                ),
                              ),
                              const Icon(
                                Icons.expand_more_rounded,
                                size: 16,
                                color: faint,
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
                gap(12),
                SizedBox(
                  height: 38,
                  child: TextField(
                    onChanged: (value) {
                      changeView(() {
                        activityQuery = value;
                        inboxEpoch++;
                        inboxGroups = null;
                      });
                      inboxSearchTimer?.cancel();
                      inboxSearchTimer = Timer(
                        const Duration(milliseconds: 250),
                        () => unawaited(loadInbox()),
                      );
                    },
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: inboxTab == 'Requests'
                          ? 'Search sessions'
                          : 'Search ${inboxTab.toLowerCase()}',
                      prefixIcon: const Icon(
                        Icons.search,
                        size: 17,
                        color: faint,
                      ),
                    ),
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
                gap(12),
                Container(
                  padding: const EdgeInsets.all(3),
                  decoration: BoxDecoration(
                    color: fieldColor,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Row(
                    children: [
                      for (final tab in ['Requests', 'Commands', 'Attention'])
                        Expanded(
                          child: Material(
                            color: inboxTab == tab
                                ? raised
                                : Colors.transparent,
                            borderRadius: BorderRadius.circular(7),
                            child: InkWell(
                              key: ValueKey('inbox-tab-$tab'),
                              borderRadius: BorderRadius.circular(7),
                              onTap: () {
                                changeView(() {
                                  inboxTab = tab;
                                  inboxShowThread = false;
                                  inboxGroups = null;
                                  inboxEpoch++;
                                });
                                unawaited(loadInbox());
                              },
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 8,
                                ),
                                child: Row(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Text(
                                      tab,
                                      style: TextStyle(
                                        fontSize: 10.5,
                                        fontWeight: FontWeight.w500,
                                        color: inboxTab == tab ? ink : muted,
                                      ),
                                    ),
                                    if (tab == 'Attention' && count > 0)
                                      Container(
                                        margin: const EdgeInsets.only(left: 3),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 3,
                                          vertical: 1,
                                        ),
                                        decoration: BoxDecoration(
                                          color: warning.withValues(alpha: .15),
                                          borderRadius: BorderRadius.circular(
                                            8,
                                          ),
                                        ),
                                        child: Text(
                                          '$count',
                                          style: const TextStyle(
                                            fontSize: 9,
                                            color: warning,
                                          ),
                                        ),
                                      ),
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
          if (inboxError != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Could not refresh conversation.',
                      style: const TextStyle(color: warning, fontSize: 12),
                    ),
                  ),
                  TextButton(
                    onPressed: () => unawaited(loadInbox()),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              children: [
                if (inboxTab == 'Requests') ...[
                  for (final g in groups)
                    inboxSessionRow(g, g['id'] == current?['id']),
                  if (groups.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: small('No matching sessions.'),
                    ),
                ],
                if (inboxTab == 'Commands') ...[
                  for (final c in commandRows()) inboxCommandRow(c),
                  if (commandRows().isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: small('No commands yet.'),
                    ),
                ],
                if (inboxTab == 'Attention') ...[
                  for (final a in attention) inboxAttentionRow(a),
                  if (attention.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: small('Nothing needs your attention.'),
                    ),
                ],
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: hairline)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    inboxTab == 'Requests'
                        ? '${groups.length} sessions · saved locally'
                        : 'Saved on this $computer',
                    style: const TextStyle(fontSize: 11, color: faint),
                  ),
                ),
                IconButton(
                  tooltip: 'How recovery works',
                  onPressed: recoveryGuide,
                  icon: const Icon(Icons.help_outline, size: 16, color: faint),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget inboxCommandRow(Map c) => ListTile(
    key: ValueKey('inbox-command-${c['id']}'),
    dense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
    onTap: () => changeView(() {
      inboxCommandSelected = '${c['id']}';
      inboxShowThread = true;
    }),
    title: Row(
      children: [
        Expanded(
          child: Text(
            '${c['label']}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
          ),
        ),
        Text(
          clock(c['created_at'] ?? 0),
          style: const TextStyle(fontSize: 10, color: faint),
        ),
      ],
    ),
    subtitle: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          c['status'] == 'blocked' ? 'Failed' : 'Done',
          style: TextStyle(
            fontSize: 11,
            color: c['status'] == 'blocked' ? warning : muted,
          ),
        ),
        Text(
          commandSummary(c),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 12, color: muted),
        ),
      ],
    ),
  );

  Widget inboxCommandDetail(Map c, {bool narrow = false}) => ListView(
    padding: const EdgeInsets.all(24),
    children: [
      if (narrow)
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton(
            onPressed: () => changeView(() => inboxShowThread = false),
            child: const Text('Back to commands'),
          ),
        ),
      Text(
        '${c['label']}',
        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
      ),
      gap(8),
      Text(
        '${c['status'] == 'blocked' ? 'Failed' : 'Done'} · ${clock(c['created_at'] ?? 0)}',
        style: const TextStyle(fontSize: 12, color: muted),
      ),
      gap(22),
      SelectableText(
        commandSummary(c),
        style: const TextStyle(fontSize: 14, height: 1.5),
      ),
    ],
  );

  Widget inboxAttentionRow(Map a) => ListTile(
    key: ValueKey('inbox-attention-${a['id']}'),
    dense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
    leading: const Icon(Icons.error_outline, size: 16, color: warning),
    title: Text(
      '${a['title']}',
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
    ),
    subtitle: Text(
      inboxText(a['text']),
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 11.5, color: muted),
    ),
    onTap: () async {
      if (a['commandId'] != null) {
        changeView(() {
          inboxTab = 'Commands';
          inboxCommandSelected = '${a['commandId']}';
          inboxShowThread = true;
        });
        return;
      }
      if (a['updateId'] != null) {
        await readLocalUpdate('${a['updateId']}');
        return;
      }
      if (a['approval'] != null) {
        await showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Waiting for you'),
            content: SizedBox(width: 400, child: approvalTile(a['approval'])),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Done'),
              ),
            ],
          ),
        );
        return;
      }
      if (a['bindingId'] != null) {
        selectInboxSession('${a['bindingId']}');
        changeView(() => inboxRequestSelected = '${a['requestId']}');
      }
      if (a['requestId'] != null) await requestTimeline('${a['requestId']}');
    },
  );

  Widget inboxSessionRow(Map g, bool selected) {
    final reviews = g['needsReview'] as num? ?? 0,
        waits = g['waitingForYou'] as num? ?? 0;
    final badge = reviews > 0 ? reviews : waits;
    final color = reviews > 0
        ? const Color(0xffff6b2c)
        : const Color(0xffe2c15d);
    return Padding(
      key: ValueKey('inbox-session-${g['id']}'),
      padding: const EdgeInsets.only(bottom: 4),
      child: Material(
        color: selected ? const Color(0xff191919) : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: selected ? line2 : Colors.transparent),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => selectInboxSession('${g['id']}'),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (sessionBinding('${g['id']}') != null)
                  logoTile(
                    sessionBinding('${g['id']}')?['provider'] == 'claude'
                        ? 'claude'
                        : 'openai',
                    size: 32,
                  )
                else
                  const Icon(Icons.mic_none, size: 30, color: muted),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              '${g['name']}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          const SizedBox(width: 5),
                          Text(
                            clock(g['latestAt'] ?? 0),
                            style: const TextStyle(
                              fontSize: 10.5,
                              color: faint,
                            ),
                          ),
                        ],
                      ),
                      gap(3),
                      Text(
                        sessionApp('${g['id']}'),
                        style: const TextStyle(fontSize: 11, color: faint),
                      ),
                      gap(4),
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              inboxText(g['preview'])
                                  .replaceAll(RegExp(r'\s+'), ' '),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 12,
                                color: muted,
                              ),
                            ),
                          ),
                          if (badge > 0)
                            Tooltip(
                              message:
                                  '$badge ${reviews > 0 ? 'need review' : 'waiting for you'}',
                              child: Container(
                                margin: const EdgeInsets.only(left: 6),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 5,
                                  vertical: 1,
                                ),
                                decoration: BoxDecoration(
                                  color: color.withValues(
                                    alpha: reviews > 0 ? 1 : .15,
                                  ),
                                  borderRadius: BorderRadius.circular(20),
                                ),
                                child: Text(
                                  '$badge',
                                  style: TextStyle(
                                    fontSize: 10,
                                    color: reviews > 0 ? Colors.white : color,
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Map> inboxSessionJobs(String id) {
    final saved = List<Map>.from(inboxThreads[id]?['jobs'] ?? []);
    return <String, Map>{
      for (final j in saved) '${j['id']}': j,
      for (final j in allJobs.where((j) => sessionKey(j) == id))
        '${j['id']}': {
          ...saved.where((s) => s['id'] == j['id']).firstOrNull ?? {},
          ...j,
        },
    }.values.toList()..sort((a, b) => jobAt(a).compareTo(jobAt(b)));
  }

  List<Map> inboxEntries(String id) {
    final jobs = inboxSessionJobs(id);
    final messages = List<Map>.from(
      inboxThreads[id]?['messages'] ??
          [
            for (final j in jobs)
              {
                'key': 'request:${j['id']}',
                'requestId': j['id'],
                'kind': requestKind(j) == 'Your request'
                    ? 'owner'
                    : requestKind(j) == 'Worker report'
                    ? 'worker-report'
                    : 'worker-task',
                'text': j['body'] ?? j['preview'],
                'at': jobAt(j),
                'destination':
                    j['destination'] ??
                    ('${j['id']}'.startsWith('tg:') ? 'tg:' : 'wa:'),
                'voice':
                    List<Map>.from(status['voiceRequests'] ?? [])
                        .any((v) => v['id'] == j['id'])
                    ? 1
                    : 0,
              },
          ],
    );
    messages.sort((a, b) {
      final n = (a['at'] as num).compareTo(b['at'] as num);
      return n != 0 ? n : '${a['key']}'.compareTo('${b['key']}');
    });
    return messages;
  }

  Widget inboxConversation(Map g, {bool narrow = false}) {
    final id = '${g['id']}', entries = inboxEntries('${g['id']}');
    final approvals = List<Map>.from(status['approvals'] ?? [])
        .where((a) => a['alias'] == sessionBinding(id)?['alias']);
    String? day;
    final contents = <Widget>[];
    for (final m in entries) {
      final nextDay = dayLabel(m['at'] ?? 0);
      if (nextDay != day) {
        contents.add(
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 18),
            child: Center(
              child: Text(
                nextDay,
                style: const TextStyle(fontSize: 11, color: faint),
              ),
            ),
          ),
        );
        day = nextDay;
      }
      contents.add(inboxMessage(m));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(18, 14, 12, 14),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: hairline)),
          ),
          child: Row(
            children: [
              if (narrow)
                IconButton(
                  tooltip: 'Back to sessions',
                  onPressed: () => changeView(() => inboxShowThread = false),
                  icon: const Icon(Icons.chevron_left),
                ),
              if (sessionBinding(id) != null)
                logoTile(
                  sessionBinding(id)?['provider'] == 'claude'
                      ? 'claude'
                      : 'openai',
                  size: 32,
                ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${g['name']}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    gap(3),
                    Text(
                      sessionApp(id),
                      style: const TextStyle(fontSize: 11.5, color: faint),
                    ),
                  ],
                ),
              ),
              TextButton.icon(
                onPressed: () => showSessionInfo(g),
                icon: const Icon(Icons.info_outline, size: 15),
                label: const Text(
                  'Session info',
                  style: TextStyle(fontSize: 12),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            key: PageStorageKey('inbox-thread-$id'),
            controller: inboxScrolls[id] ??= ScrollController(),
            padding: const EdgeInsets.fromLTRB(22, 0, 22, 22),
            children: [
              if (inboxThreads[id]?['next'] != null)
                Center(
                  child: TextButton(
                    onPressed: inboxOlderLoading
                        ? null
                        : () => unawaited(loadInboxThread(id, older: true)),
                    child: Text(
                      inboxOlderLoading ? 'Loading…' : 'Load earlier messages',
                    ),
                  ),
                ),
              ...contents,
              for (final a in approvals) approvalTile(a),
              if (entries.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(20),
                  child: small(
                    inboxLoading
                        ? 'Loading conversation…'
                        : 'No messages loaded.',
                  ),
                ),
            ],
          ),
        ),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: hairline)),
          ),
          child: const Text(
            'Messages are read-only here. Continue in your connected chat.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11.5, color: faint),
          ),
        ),
      ],
    );
  }

  Widget inboxMessage(Map m) {
    final fromYou = m['kind'] == 'owner',
        failed = m['kind'] == 'voice-failed',
        voice = m['voice'] == 1;
    final label = switch (m['kind']) {
      'owner' => 'You',
      'worker-report' => 'Worker report',
      'worker-task' => 'Delegated task',
      'progress' => 'Progress',
      'final' => 'Final',
      'hook' => 'Session update',
      'system' => 'Notice',
      'voice-failed' => 'Voice note not delivered',
      _ => 'Reply',
    };
    final channel = '${m['destination'] ?? ''}'.startsWith('tg:')
        ? 'Telegram'
        : '${m['destination'] ?? ''}'.isNotEmpty
        ? 'WhatsApp'
        : 'Saved locally';
    return GestureDetector(
      onTap: () => changeView(() => inboxRequestSelected = '${m['requestId']}'),
      child: Padding(
        key: ValueKey('inbox-message-${m['key']}'),
        padding: const EdgeInsets.only(bottom: 15),
        child: Align(
          alignment: fromYou || failed
              ? Alignment.centerRight
              : Alignment.centerLeft,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 580),
            child: Column(
              crossAxisAlignment: fromYou || failed
                  ? CrossAxisAlignment.end
                  : CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 11,
                  ),
                  decoration: BoxDecoration(
                    color: failed
                        ? danger.withValues(alpha: .08)
                        : fromYou
                        ? const Color(0xff1d415b)
                        : const Color(0xff141414),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(
                      color: failed
                          ? danger.withValues(alpha: .4)
                          : fromYou
                          ? Colors.transparent
                          : line2,
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (voice || failed || m['kind'] == 'worker-report')
                        Padding(
                          padding: const EdgeInsets.only(bottom: 7),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                voice
                                    ? Icons.mic_none
                                    : Icons.description_outlined,
                                size: 12,
                                color: failed ? danger : muted,
                              ),
                              const SizedBox(width: 5),
                              Text(
                                failed
                                    ? 'Voice note not delivered'
                                    : voice
                                    ? 'Voice transcript'
                                    : 'Worker report',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: failed ? danger : muted,
                                ),
                              ),
                            ],
                          ),
                        ),
                      SelectableText(
                        inboxText(m['text']),
                        style: const TextStyle(fontSize: 13, height: 1.5),
                      ),
                      if (failed)
                        TextButton(
                          onPressed: () => requestTimeline('${m['requestId']}'),
                          child: const Text('Details'),
                        ),
                    ],
                  ),
                ),
                gap(5),
                Text(
                  '$label · $channel · ${clock(m['at'] ?? 0)}${m['delivery'] == null ? '' : ' · ${m['delivery']}'}',
                  style: const TextStyle(fontSize: 10.5, color: faint),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> showSessionInfo(Map g) => showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Session info'),
      content: SizedBox(
        width: 440,
        height: 460,
        child: StatefulBuilder(
          builder: (context, update) => inboxSessionInfo(
            g,
            redraw: (change) {
              if (context.mounted) update(change);
            },
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

  Widget inboxSessionInfo(Map g, {StateSetter? redraw}) {
    final id = '${g['id']}', b = sessionBinding('${g['id']}');
    final jobs = inboxSessionJobs(id)
      ..sort(
        (a, b) => ((b['updated_at'] ?? jobAt(b)) as num).compareTo(
          (a['updated_at'] ?? jobAt(a)) as num,
        ),
      );
    final job =
        jobs.where((j) => j['id'] == inboxRequestSelected).firstOrNull ??
        jobs.firstOrNull;
    final destinations = inboxEntries(id)
        .where((m) => m['destination'] != null)
        .map(
          (m) =>
              '${m['destination']}'.startsWith('tg:') ? 'Telegram' : 'WhatsApp',
        )
        .toSet();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          '${g['name']}',
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
        gap(5),
        small(sessionApp(id)),
        gap(20),
        for (final f in [
          ('Folder', '${b?['cwd'] ?? 'Not assigned'}'),
          ('Session ID', '${b?['native_id'] ?? 'Not assigned'}'),
          (
            'Replies go to',
            destinations.isEmpty
                ? 'Original request chat'
                : destinations.join(' / '),
          ),
        ]) ...[
          Text(f.$1, style: const TextStyle(fontSize: 11, color: faint)),
          gap(5),
          SelectableText(
            f.$2,
            style: const TextStyle(fontSize: 12, height: 1.4),
          ),
          gap(16),
        ],
        if (job != null) ...[
          if (jobs.length > 1)
            DropdownButtonFormField<String>(
              key: ValueKey('info-request-${job['id']}'),
              initialValue: '${job['id']}',
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Request'),
              items: [
                for (final j in jobs)
                  DropdownMenuItem(
                    value: '${j['id']}',
                    child: Text(
                      inboxText(j['body'] ?? j['preview'])
                          .replaceAll(RegExp(r'\s+'), ' '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: (id) {
                changeView(() => inboxRequestSelected = id);
                redraw?.call(() {});
              },
            ),
          gap(12),
          const Text(
            'Request status',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          ),
          gap(10),
          stepRow('Received', detail: clock(jobAt(job)), state: 'done'),
          stepRow(
            'Sent to session',
            detail: job['submitted_at'] is num
                ? clock(job['submitted_at'])
                : 'Not confirmed',
            state: job['submitted_at'] is num ? 'done' : 'wait',
          ),
          stepRow(
            requestState(job),
            state: needsReview(job)
                ? 'wait'
                : job['status'] == 'completed'
                ? 'done'
                : 'wait',
          ),
          TextButton(
            onPressed: () => requestTimeline('${job['id']}'),
            child: const Text('Timing and delivery'),
          ),
          if (job['canClose'] == true)
            button(
              'Mark reviewed',
              () async {
                if (await confirm(
                  'Close this request after review?',
                  'Tracking ends only for this request. History is kept; native work is not stopped or marked successful.',
                )) {
                  await post('/api/request-review', {
                    'requestId': job['id'],
                    'expectedStatus': job['status'],
                    'confirmed': true,
                  });
                  await loadInboxThread(sessionKey(job));
                  if (mounted) redraw?.call(() {});
                }
              },
              compact: true,
              primary: true,
            ),
          if (job['error'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                '${job['error']}',
                style: const TextStyle(fontSize: 12, color: warning),
              ),
            ),
          if (![
            'completed',
            'reviewed',
            'replaced',
            'auto_closed',
          ].contains(job['status']))
            TextButton(
              onPressed: () => document(job),
              child: const Text('Send reviewed document'),
            ),
        ],
      ],
    );
  }

  // Items: a board with one column per state.

  Widget itemsBoard() {
    final q = itemQuery.toLowerCase();
    final all = workItems;
    final shown = all
        .where(
          (i) =>
              '${i['title']} ${i['session'] ?? ''}'.toLowerCase().contains(q),
        )
        .toList();
    String column(Map i) => switch ('${i['status']}') {
      'waiting on owner' || 'blocked' => 'Needs you',
      'in progress' => 'In progress',
      'done' => 'Done',
      _ => 'Open',
    };
    const columns = [
      ('Needs you', warning),
      ('In progress', ink),
      ('Open', faint),
      ('Done', success),
    ];
    final brainOn = status['metaBrain']?['enabled'] == true;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 22, 24, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          'Items',
                          style: Theme.of(context).textTheme.headlineLarge,
                        ),
                        infoTip(
                          'Items are work your proxies follow up on. Each has a number you can use from your phone, like "update on 6". Ask "where are we" to get this list.',
                          label: 'About items',
                        ),
                      ],
                    ),
                    gap(4),
                    small(
                      'Follow-up work your proxies track. Say "update on 6" from your phone.',
                    ),
                  ],
                ),
              ),
              small('${all.length} items · $itemsNeedingYou need you'),
              const SizedBox(width: 14),
              SizedBox(
                width: 200,
                height: 38,
                child: TextField(
                  onChanged: (v) => changeView(() => itemQuery = v),
                  decoration: const InputDecoration(
                    isDense: true,
                    prefixIcon: Icon(Icons.search, size: 17, color: faint),
                    hintText: 'Search items or sessions',
                  ),
                  style: const TextStyle(fontSize: 13),
                ),
              ),
              const SizedBox(width: 10),
              spinButton(
                'Refresh',
                'Refreshing…',
                () => loadItems(fresh: true),
              ),
            ],
          ),
          gap(16),
          if (all.isEmpty)
            Expanded(
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      'No items here',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    gap(4),
                    small(
                      brainOn
                          ? 'Say "add this" on your phone while asking for work.'
                          : 'Turn on the brain to keep an item list.',
                    ),
                    if (!brainOn) ...[
                      gap(10),
                      button('Open Brain', () => go(3), compact: true),
                    ],
                  ],
                ),
              ),
            )
          else
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final (n, c) in columns.indexed) ...[
                    if (n > 0) const SizedBox(width: 12),
                    Expanded(
                      child: boardColumn(
                        c.$1,
                        c.$2,
                        shown.where((i) => column(i) == c.$1).toList(),
                      ),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget boardColumn(String name, Color dot, List<Map> items) => Container(
    decoration: BoxDecoration(
      color: sidebarColor,
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: line2),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 14, 12, 10),
          child: Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  name,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0xff1c1c1c),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  '${items.length}',
                  style: const TextStyle(fontSize: 11.5, color: muted),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
            children: [for (final i in items) itemCard(i)],
          ),
        ),
      ],
    ),
  );

  Widget itemCard(Map i) {
    final status = '${i['status']}';
    final work = i['executionState'] == null ? '' : ' · ${i['executionState']}';
    final needs = ['waiting on owner', 'blocked'].contains(status);
    final (IconData? icon, String text, Color color) = switch (status) {
      'blocked' => (Icons.shield_outlined, 'Blocked$work', warning),
      'waiting on owner' => (
        Icons.shield_outlined,
        'Waiting on you$work',
        warning,
      ),
      'in progress' => (null, 'Running$work', ink2),
      'done' => (Icons.check_rounded, 'Done', success),
      _ => (Icons.schedule_rounded, 'Not started$work', faint),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xff131313),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: needs ? warning.withValues(alpha: .35) : line2,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: '#${i['id']}  ',
                  style: const TextStyle(color: faint, fontSize: 12.5),
                ),
                TextSpan(text: '${i['title']}'),
              ],
            ),
            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
          gap(8),
          Row(
            children: [
              const Icon(Icons.terminal_rounded, size: 13, color: faint),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${i['session'] ?? 'No session yet'}',
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: muted),
                ),
              ),
            ],
          ),
          gap(10),
          const Divider(height: 1, color: line2),
          gap(8),
          Row(
            children: [
              if (icon == null)
                SizedBox(width: 11, height: 11, child: spinner(color))
              else
                Icon(icon, size: 13, color: color),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  text,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: color),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // Settings: a sub-nav that scrolls to each group of cards.

  Widget settingsPane() {
    final sections = settingsSections();
    final body = SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 22, 28, 40),
      child: Align(
        alignment: Alignment.topLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final s in sections) ...[
                Padding(
                  key: settingsKeys[s.$1] ??= GlobalKey(),
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.$1,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      gap(2),
                      small(s.$2),
                    ],
                  ),
                ),
                ...s.$4,
                gap(20),
              ],
            ],
          ),
        ),
      ),
    );
    return LayoutBuilder(
      builder: (context, box) => box.maxWidth < 860
          ? body
          : Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(
                  width: 220,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(20, 22, 0, 20),
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(10, 0, 0, 16),
                        child: Text(
                          'Settings',
                          style: Theme.of(context).textTheme.headlineLarge,
                        ),
                      ),
                      for (final s in sections) settingsNavItem(s.$1, s.$3),
                    ],
                  ),
                ),
                Expanded(child: body),
              ],
            ),
    );
  }

  Widget settingsNavItem(String title, IconData icon) {
    final on = settingsTab == title;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: on ? const Color(0xff161616) : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(9),
          side: BorderSide(color: on ? line2 : Colors.transparent),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: () {
            changeView(() => settingsTab = title);
            final target = settingsKeys[title]?.currentContext;
            if (target != null) {
              Scrollable.ensureVisible(
                target,
                duration: const Duration(milliseconds: 250),
                curve: Curves.easeOut,
              );
            }
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            child: Row(
              children: [
                Icon(icon, size: 16, color: on ? ink : faint),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    title,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w500,
                      color: on ? ink : muted,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

part of 'app.dart';

/// Inbox, Items and Settings from the FarFromDesk Studio design. Each fills
/// the content area instead of scrolling as one long column.
extension _Panes on _DeskState {
  Widget? paneScreen() => switch (section) {
    1
        when connected ||
            allJobs.isNotEmpty ||
            (status['approvals'] ?? []).isNotEmpty =>
      inboxPane(),
    2 => itemsBoard(),
    4 => settingsPane(),
    _ => null,
  };

  // Inbox: request list, thread, and facts about the selected request.

  Color jobColor(Map j) {
    final st = '${j['status']}';
    if (j['outcome'] == 'blocked') return danger;
    if (['uncertain', 'failed'].contains(st)) return warning;
    if (st == 'completed') return success;
    if (['reviewed', 'replaced', 'auto_closed'].contains(st)) return faint;
    return ink2;
  }

  String jobSession(Map j) {
    final b = requestBinding(j);
    return '${b?['name'] ?? b?['alias'] ?? 'Coding session'}';
  }

  String jobApp(Map j) {
    final b = requestBinding(j);
    return '${{'claude': 'Claude', 'codex': 'Codex'}[b?['provider']] ?? 'Coding'} ${{'desktop': 'Desktop', 'cli': 'CLI'}[b?['executionMode']] ?? 'session'}';
  }

  Widget inboxPane() {
    final query = activityQuery.trim().toLowerCase();
    final jobs =
        allJobs
            .where(
              (j) =>
                  includeJob(j, activityFilter) &&
                  '${requestTitle(j)} ${jobSession(j)} ${j['id']}'
                      .toLowerCase()
                      .contains(query),
            )
            .toList()
          ..sort((a, b) => jobAt(b).compareTo(jobAt(a)));
    final job =
        jobs.where((j) => j['id'] == inboxSelected).firstOrNull ??
        jobs.firstOrNull;
    return LayoutBuilder(
      builder: (context, box) => Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: 300,
            decoration: const BoxDecoration(
              border: Border(right: BorderSide(color: hairline)),
            ),
            child: inboxList(jobs, job),
          ),
          Expanded(
            child: job == null
                ? Center(
                    child: small(
                      query.isNotEmpty || activityFilter != 'All'
                          ? 'No matching requests. Try another filter or search.'
                          : 'Send a task in your connected chat to get started.',
                    ),
                  )
                : inboxThread(job),
          ),
          if (job != null && box.maxWidth >= 900)
            Container(
              width: 280,
              decoration: const BoxDecoration(
                border: Border(left: BorderSide(color: hairline)),
              ),
              child: inboxFacts(job),
            ),
        ],
      ),
    );
  }

  Widget inboxList(List<Map> jobs, Map? current) {
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
    final approvals = List<Map>.from(status['approvals'] ?? []);
    const filters = ['All', 'Waiting', 'Needs review', 'Answered', 'Closed'];
    final rows = <Widget>[];
    String? lastDay;
    for (final j in jobs) {
      final day = dayLabel(jobAt(j));
      if (day != lastDay) {
        rows.add(
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 12, 8, 6),
            child: Text(
              day,
              style: const TextStyle(fontSize: 11.5, color: faint2),
            ),
          ),
        );
        lastDay = day;
      }
      rows.add(inboxRow(j, j['id'] == current?['id'], eligibleIds.isNotEmpty));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 16, 14, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Inbox',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  small('${allJobs.length} requests'),
                ],
              ),
              gap(12),
              segmented(
                filters,
                activityFilter,
                (filter) => changeView(() => activityFilter = filter),
                key: const ValueKey('activity-filter-group'),
                compact: true,
              ),
              gap(10),
              SizedBox(
                height: 38,
                child: TextField(
                  onChanged: (value) => changeView(() => activityQuery = value),
                  decoration: const InputDecoration(
                    isDense: true,
                    hintText: 'Search requests or sessions',
                    prefixIcon: Icon(Icons.search, size: 17, color: faint),
                  ),
                  style: const TextStyle(fontSize: 13),
                ),
              ),
              if (eligibleIds.isNotEmpty || chosen.isNotEmpty)
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
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
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            children: [
              for (final a in approvals) approvalTile(a),
              ...inboxNotices(),
              ...rows,
            ],
          ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 4, 6, 4),
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: hairline)),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '${(status['pendingJobs'] ?? []).length} unfinished · saved on this $computer',
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11.5, color: faint),
                ),
              ),
              TextButton(
                onPressed: recoveryGuide,
                child: const Text('How recovery works'),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget inboxRow(Map job, bool selected, bool selectable) {
    final color = jobColor(job);
    return Padding(
      key: PageStorageKey('request-${job['id']}'),
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected ? const Color(0xff161616) : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: selected ? line : Colors.transparent),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => changeView(() => inboxSelected = job['id']),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (selectable)
                  SizedBox(
                    width: 30,
                    height: 30,
                    child: job['canClose'] != true
                        ? null
                        : Checkbox(
                            value: chosen.contains(job['id']),
                            onChanged: (value) => changeView(() {
                              if (value == true) {
                                chosen.add(job['id']);
                              } else {
                                chosen.remove(job['id']);
                              }
                            }),
                          ),
                  ),
                Stack(
                  clipBehavior: Clip.none,
                  children: [
                    logoTile(
                      requestBinding(job)?['provider'] == 'claude'
                          ? 'claude'
                          : 'openai',
                      size: 30,
                    ),
                    Positioned(
                      right: -2,
                      bottom: -2,
                      child: Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: color,
                          shape: BoxShape.circle,
                          border: Border.all(color: windowColor, width: 2),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(width: 12),
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
                      gap(2),
                      Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(text: '${jobSession(job)} · '),
                            TextSpan(
                              text: requestState(job),
                              style: TextStyle(color: color),
                            ),
                          ],
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: faint),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  clock(jobAt(job)),
                  style: const TextStyle(fontSize: 11.5, color: faint),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget inboxThread(Map job) {
    final st = '${job['status']}';
    final review =
        ['uncertain', 'failed'].contains(st) || job['outcome'] == 'blocked';
    final closed = ['reviewed', 'replaced', 'auto_closed'].contains(st);
    final sending = ['queued', 'dispatched'].contains(st);
    final waiting = sending || st == 'submitted';
    final session = jobSession(job);
    final channel = usingTelegram ? 'Telegram' : 'WhatsApp';
    final at = clock(jobAt(job));
    final fromYou = requestKind(job) == 'Your request';
    final color = jobColor(job);
    Widget pill(String text, Color dot) => Center(
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: dot == warning ? warning.withValues(alpha: .06) : fieldColor,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: dot == warning ? warning.withValues(alpha: .35) : line2,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                text,
                style: TextStyle(
                  fontSize: 12,
                  color: dot == warning ? warning : muted,
                ),
              ),
            ),
          ],
        ),
      ),
    );
    final (String head, String detail) = review
        ? (
            job['outcome'] == 'blocked' ? 'Blocked' : 'Needs review',
            job['error'] ??
                'Delivery or completion could not be confirmed. Check the session in ${jobApp(job)} before sending anything again. This request will not be resent automatically.',
          )
        : waiting
        ? (
            'Waiting for the session',
            'The reply goes to your chat when $session answers.',
          )
        : closed
        ? ('Closed', 'Tracking ended. History is kept.')
        : ('Answered', 'The reply was recorded and sent to your chat.');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(22, 16, 22, 14),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: hairline)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      requestTitle(job),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    gap(4),
                    SelectionArea(
                      child: Text(
                        'Request ${job['id']} · ${fromYou ? 'from $channel' : requestKind(job)}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: faint),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              stateChip(job),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(22, 22, 22, 12),
            children: [
              Align(
                alignment: fromYou
                    ? Alignment.centerRight
                    : Alignment.centerLeft,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 11,
                    ),
                    decoration: BoxDecoration(
                      color: fromYou ? tonePine : raised,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: SelectionArea(
                      child: Text(
                        '${job['preview'] ?? requestTitle(job)}',
                        style: const TextStyle(fontSize: 14, height: 1.45),
                      ),
                    ),
                  ),
                ),
              ),
              gap(6),
              Align(
                alignment: fromYou
                    ? Alignment.centerRight
                    : Alignment.centerLeft,
                child: Text(
                  '${fromYou ? 'You · $channel' : requestKind(job)} · $at',
                  style: const TextStyle(fontSize: 11.5, color: faint),
                ),
              ),
              gap(16),
              pill(
                sending ? 'Sending to $session' : 'Sent to $session',
                sending ? ink2 : success,
              ),
              if (!sending)
                pill(
                  st == 'submitted' ? 'Awaiting reply' : requestState(job),
                  color,
                ),
              if (job['last_error'] != null && job['error'] == null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Center(
                    child: small(
                      'Earlier error (cleared after a later response): ${job['last_error']}',
                    ),
                  ),
                ),
            ],
          ),
        ),
        Container(
          margin: const EdgeInsets.fromLTRB(18, 0, 18, 18),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: fieldColor,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    review ? Icons.error_outline_rounded : Icons.info_outline,
                    size: 16,
                    color: review ? warning : muted,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          head,
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        gap(2),
                        small(detail),
                      ],
                    ),
                  ),
                ],
              ),
              gap(12),
              Wrap(
                alignment: WrapAlignment.end,
                spacing: 8,
                runSpacing: 8,
                children: [
                  button(
                    'Timing and delivery',
                    () => requestTimeline(job['id']),
                    compact: true,
                  ),
                  if (!closed && st != 'completed')
                    button(
                      'Send reviewed document',
                      () => document(job),
                      compact: true,
                    ),
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
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget inboxFacts(Map job) {
    final binding = requestBinding(job);
    final st = '${job['status']}';
    final review =
        ['uncertain', 'failed'].contains(st) || job['outcome'] == 'blocked';
    final sending = ['queued', 'dispatched'].contains(st);
    final updated = job['updated_at'];
    final minutes = updated is num
        ? ((updated - jobAt(job)) / 60000).round()
        : null;
    final facts = [
      ('Folder', '${binding?['cwd'] ?? 'Unavailable'}'),
      ('Session ID', '${binding?['native_id'] ?? 'Unknown'}'),
      if (minutes != null && minutes > 0) ('Duration', '${minutes}m'),
      ('Reply to', replyPlace),
    ];
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: fieldColor,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: line2),
          ),
          child: Row(
            children: [
              logoTile(
                binding?['provider'] == 'claude' ? 'claude' : 'openai',
                size: 34,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      jobSession(job),
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      jobApp(job),
                      style: const TextStyle(fontSize: 11.5, color: faint),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        gap(16),
        const Text('Timeline', style: TextStyle(fontSize: 11.5, color: faint)),
        gap(4),
        stepRow(
          'Received from your chat',
          detail: clock(jobAt(job)),
          state: 'done',
        ),
        stepRow(
          sending ? 'Sending to session' : 'Sent to session',
          detail: jobSession(job),
          state: sending ? 'now' : 'done',
        ),
        stepRow(
          sending
              ? 'Reply'
              : st == 'submitted'
              ? 'Awaiting reply'
              : requestState(job),
          detail: sending ? 'Sent to your chat when the session answers' : null,
          state: sending
              ? 'pending'
              : st == 'submitted'
              ? 'now'
              : job['outcome'] == 'blocked'
              ? 'fail'
              : review
              ? 'wait'
              : 'done',
        ),
        gap(16),
        Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: line2),
          ),
          child: Column(
            children: [
              for (final (i, f) in facts.indexed)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    border: i == 0
                        ? null
                        : const Border(top: BorderSide(color: line2)),
                  ),
                  child: Row(
                    children: [
                      Text(
                        f.$1,
                        style: const TextStyle(fontSize: 12.5, color: faint),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          f.$2,
                          textAlign: TextAlign.right,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12.5, color: ink2),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
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

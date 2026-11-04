part of 'app.dart';

/// Inbox and Settings from the FarFromDesk Studio design. Each fills
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
    4 => settingsPane(),
    6 when api.preview || const bool.fromEnvironment('FFD_ISOLATED_LOCAL') =>
      api.preview
          ? const SocialPreview()
          : SocialScreen(key: socialKey, gateway: api),
    _ => null,
  };

  // One binding identity per saved session; never a request title or a display
  // name, both of which can be reused across sessions.
  String sessionKey(Map j) =>
      '${j['binding_id'] ?? j['master_id'] ?? status['master']?['id'] ?? 'unassigned'}';
  Map? sessionBinding(String id) =>
      List<Map>.from(status['bindings'] ?? [])
          .where((b) => b['id'] == id)
          .firstOrNull;
  String sessionApp(String id) {
    final b = sessionBinding(id);
    if (b == null) return 'Not routed to a session';
    final provider = providerLabel(b['provider']);
    final mode = switch (b['executionMode']) {
      'desktop' => 'Desktop',
      'cli' => 'CLI',
      _ => 'session',
    };
    return '$provider $mode';
  }

  /// Strips the bridge's own wrappers so a bubble shows the message body only.
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

  /// A reply body carries the bridge's own attribution as a trailing block:
  /// "🤖 Provider: Codex Desktop", "💬 Session Name: ...", "🎨 Mode: ..." or the
  /// short form "🤖 Codex Desktop". It is metadata, not message text, so the
  /// bubble must never show it.
  /// The four marks the bridge uses to introduce its own attribution lines.
  /// Matched as characters, not as a regular expression: `\u{...}` needs the
  /// unicode flag in a RegExp and silently matches nothing without it.
  static const inboxMarks = [
    '\u{1F916}',
    '\u{1F4AC}',
    '\u{1F3A8}',
    '\u{1F516}',
  ];

  String? inboxMark(String line) {
    final text = line.trim();
    for (final mark in inboxMarks) {
      if (text.startsWith(mark)) return mark;
    }
    return null;
  }

  /// The words the bridge introduces its metadata with. A real reply writes
  /// them with or without its mark - 18 of the 19 rows in the live database
  /// carry no emoji at all - so both forms have to be recognised.
  static const inboxMetaWords = ['Provider:', 'Session Name:', 'Mode:'];

  /// The metadata word this line introduces, mark or no mark. Null means the
  /// line is ordinary message text.
  String? inboxMetaWord(String line) {
    final text = line.trim();
    final mark = inboxMark(text);
    final body = mark == null ? text : text.substring(mark.length).trim();
    for (final word in inboxMetaWords) {
      if (body.startsWith(word)) return word;
    }
    return null;
  }

  /// A trailing line is the bridge's own metadata when it carries a mark or one
  /// of the metadata words. Only lines inside the last block are ever tested,
  /// so the same words in the body stay untouched.
  bool inboxMetadataLine(String line) =>
      inboxMark(line) != null || inboxMetaWord(line) != null;

  String inboxFieldValue(String body, String label) {
    final prefix = '$label:';
    final text = body.startsWith(prefix) ? body.substring(prefix.length) : body;
    return text.trim();
  }

  /// The attribution block, read only from what follows the last blank line so
  /// a leading "💬 *Reply*" marker can never be mistaken for metadata.
  ({String provider, String session, String mode}) inboxMetadata(
    dynamic value,
  ) {
    var provider = '', session = '', mode = '';
    // Read the message as the bubble will: the trailing "— FarFromDesk" footer
    // and the leading "*Session: ...*" header are not part of the block, and
    // real rows put the Mode line after that footer.
    final text = inboxText(value);
    final cut = text.lastIndexOf('\n\n');
    final tail = cut < 0 ? text : text.substring(cut + 2);
    for (final raw in tail.split('\n')) {
      final line = raw.trim();
      final mark = inboxMark(line);
      final word = inboxMetaWord(line);
      if (mark == null && word == null) continue;
      final body = mark == null ? line : line.substring(mark.length).trim();
      if (word != null) {
        if (word == inboxMetaWords[0]) {
          provider = inboxFieldValue(body, 'Provider');
        } else if (word == inboxMetaWords[1]) {
          session = inboxFieldValue(body, 'Session Name');
        } else {
          mode = inboxFieldValue(body, 'Mode');
        }
      } else if (mark == inboxMarks[0]) {
        // The short form names the provider and nothing else.
        provider = inboxFieldValue(body, 'Provider');
      } else if (mark == inboxMarks[1]) {
        session = inboxFieldValue(body, 'Session Name');
      } else if (mark == inboxMarks[2]) {
        mode = inboxFieldValue(body, 'Mode');
      }
    }
    return (provider: provider, session: session, mode: mode);
  }

  /// The message as the owner should read it: the body, without the trailing
  /// attribution block. A body that was nothing but metadata collapses to an
  /// empty bubble rather than a dangling label.
  String inboxBody(dynamic value) {
    final text = inboxText(value);
    if (text.isEmpty) return text;
    final cut = text.lastIndexOf('\n\n');
    final head = cut < 0 ? '' : text.substring(0, cut).trimRight();
    final tail = cut < 0 ? text : text.substring(cut + 2);
    final kept = [
      for (final line in tail.split('\n'))
        if (!inboxMetadataLine(line)) line,
    ]..removeWhere((line) => line.trim().isEmpty);
    if (kept.isEmpty) return head;
    return [if (head.isNotEmpty) head, ...kept].join('\n');
  }

  /// The provider the reply names. A body that spells out "Codex Desktop"
  /// carries more than a bare provider key, so the block wins when present.
  String inboxProviderText(Map m) {
    final named = inboxMetadata(m['text']).provider;
    if (named.isNotEmpty) return named;
    final provider = '${m['provider'] ?? ''}';
    return provider.isEmpty ? '' : providerLabel(provider);
  }

  String inboxProviderBrand(Map m) {
    final text = inboxProviderText(m).toLowerCase();
    if (text.contains('claude')) return 'claude';
    if (text.contains('muse')) return 'muse';
    return providerBrand(m['provider']);
  }

  String inboxSessionText(Map m) {
    final session = '${m['sessionName'] ?? ''}';
    return session.isNotEmpty ? session : inboxMetadata(m['text']).session;
  }

  // The composer is honest about what this build can do: text replies are sent
  // as the owner and routed exactly like a message to yourself; anything else
  // still belongs in the chat app.
  static const inboxOnlyText =
      'Only text replies are supported here. Send photos or voice from WhatsApp or Telegram.';
  static const inboxSendNote =
      'Send as yourself. The brain routes it, or your coordinator answers.';

  // ---------------------------------------------------------------- inbox feed

  num? inboxNumber(dynamic value) => value is num ? value : null;
  String inboxKind(Map m) => '${m['kind'] ?? ''}';
  String inboxSource(Map m) => '${m['source'] ?? ''}';
  String inboxState(dynamic delivery) =>
      delivery is Map ? '${delivery['state'] ?? ''}' : '';

  /// The delivery vocabulary the feed reports, in the words the panel uses.
  /// An unknown or missing state reads as nothing rather than as a claim.
  String inboxDeliveryWord(dynamic delivery) => switch (inboxState(delivery)) {
    'delivered' => 'Delivered',
    'sent' => 'Sent to session',
    'queued' => 'Queued',
    'failed' => 'Not delivered',
    'uncertain' => 'Not confirmed',
    _ => '',
  };

  /// One or two ticks after the time, matching what the chat app would show.
  String inboxTicks(dynamic delivery) => switch (inboxState(delivery)) {
    'delivered' => '✓✓',
    'sent' => '✓',
    'failed' => '!',
    _ => '',
  };

  String inboxDuration(dynamic voice) {
    final ms = voice is Map ? inboxNumber(voice['durationMs']) : null;
    if (ms == null) return '';
    final seconds = (ms / 1000).round();
    return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
  }

  /// "09:41" today, "Yesterday", "Oct 29" before that. Empty when the feed gave
  /// no timestamp, so a row never invents one.
  String inboxStamp(num? at) {
    if (at == null) return '';
    final t = DateTime.fromMillisecondsSinceEpoch(at.toInt()).toLocal();
    final now = DateTime.now();
    final days = DateTime(
      now.year,
      now.month,
      now.day,
    ).difference(DateTime(t.year, t.month, t.day)).inDays;
    if (days == 0) return clock(at);
    if (days == 1) return 'Yesterday';
    return '${_monthNames[t.month - 1].substring(0, 3)} ${t.day}';
  }

  String inboxStarted(num? at) {
    if (at == null) return '';
    final label = dayLabel(at);
    return 'Started $label at ${clock(at)}';
  }

  String inboxFallback(Object e, String fallback) {
    final text = clean(e);
    return text.isEmpty ? fallback : text;
  }

  /// Loads one page of the unified feed. `older` walks the `next` cursor and
  /// restores the reading position; a refresh follows the bottom only when the
  /// reader was already there. A failure never clears the last good page.
  Future<void> loadInboxFeed({bool older = false}) async {
    if (older && inboxOlderLoading) return;
    // A request for the same page is already in flight and must not be stacked.
    // A different epoch means the owner moved on, and that new view has to load
    // even though the old request has not answered yet.
    if (!older && inboxLoading && inboxLoadingEpoch == inboxEpoch) return;
    final epoch = inboxEpoch;
    if (older) {
      changeView(() => inboxOlderLoading = true);
    } else {
      inboxLoading = true;
      inboxLoadingEpoch = epoch;
    }
    final scroll = inboxScroll;
    final previousOffset = scroll?.hasClients == true ? scroll!.offset : 0.0;
    final previousExtent = scroll?.hasClients == true
        ? scroll!.position.maxScrollExtent
        : 0.0;
    final followLatest = previousExtent - previousOffset < 80;
    final next = older ? inboxNext : null;
    final hadMessages = inboxMessages.isNotEmpty;
    try {
      final query = inboxQuery.trim();
      final data = await api.get(
        '/api/inbox-feed?view=${Uri.encodeComponent(inboxViewId)}'
        '${query.isEmpty ? '' : '&q=${Uri.encodeComponent(query)}'}'
        '${next == null ? '' : '&beforeAt=${next['at']}&beforeKey=${Uri.encodeComponent('${next['key']}')}'}',
      );
      if (!mounted || epoch != inboxEpoch) return;
      final previousMessages = inboxMessages;
      final incoming = data['messages'] is List
          ? List<Map>.from(data['messages'])
          : <Map>[];
      // A refresh of the newest page must not reset an older page's cursor.
      final gapInHistory =
          previousMessages.isNotEmpty &&
          incoming.isNotEmpty &&
          ((inboxNumber(incoming.first['at']) ?? 0) >
                  (inboxNumber(previousMessages.last['at']) ?? 0) ||
              (incoming.first['at'] == previousMessages.last['at'] &&
                  '${incoming.first['key']}'.compareTo(
                        '${previousMessages.last['key']}',
                      ) >
                      0)) &&
          data['next'] is Map;
      final merged =
          (older || inboxLoadedOlder
                ? <String, Map>{
                    for (final m in previousMessages) '${m['key']}': m,
                    for (final m in incoming) '${m['key']}': m,
                  }.values.toList()
                : List<Map>.from(incoming))
            ..sort((a, b) {
              final order = (inboxNumber(a['at']) ?? 0).compareTo(
                inboxNumber(b['at']) ?? 0,
              );
              return order != 0
                  ? order
                  : '${a['key']}'.compareTo('${b['key']}');
            });
      unawaited(loadMetaEvents());
      changeView(() {
        if (data['views'] is List) inboxViews = List<Map>.from(data['views']);
        // The chip row reads its counts from `filters`, which reports every
        // group even when it holds no messages.
        if (data['filters'] is List) {
          inboxFilters = List<Map>.from(data['filters']);
        }
        if (data['view'] is Map) {
          inboxView = Map<String, dynamic>.from(data['view'] as Map);
        }
        if (data['stats'] is Map) {
          inboxStats = Map<String, dynamic>.from(data['stats'] as Map);
        }
        inboxMessages = merged;
        inboxLoadedOlder = inboxLoadedOlder || older;
        if (older || gapInHistory || (next == null && !hadMessages)) {
          inboxNext = data['next'] is Map
              ? Map<String, dynamic>.from(data['next'] as Map)
              : null;
        }
        inboxAttempted = true;
        inboxError = null;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final controller = inboxScroll;
        if (!mounted || controller?.hasClients != true) return;
        if (older) {
          controller!.jumpTo(
            (previousOffset +
                    controller.position.maxScrollExtent -
                    previousExtent)
                .clamp(0.0, controller.position.maxScrollExtent),
          );
        } else if (previousMessages.isEmpty || followLatest) {
          controller!.jumpTo(controller.position.maxScrollExtent);
        }
      });
    } catch (e) {
      if (mounted && epoch == inboxEpoch) {
        changeView(
          () =>
              inboxError = inboxFallback(e, 'Could not refresh conversation.'),
        );
      }
    } finally {
      if (mounted) {
        changeView(() {
          if (older) {
            inboxOlderLoading = false;
          } else {
            inboxLoading = false;
          }
          inboxAttempted = true;
        });
      }
    }
  }

  void selectInboxView(String id) {
    if (id.isEmpty || id == inboxViewId) {
      changeView(() => inboxShowConversation = true);
      return;
    }
    changeView(() {
      inboxViewId = id;
      inboxRequestSelected = null;
      inboxShowConversation = true;
      inboxError = null;
      // The previous view's messages must not sit under the new title while the
      // new page loads.
      inboxMessages = [];
      inboxNext = null;
      inboxView = {};
      inboxEpoch++;
    });
    unawaited(loadInboxFeed());
  }

  /// Posts the typed reply exactly once. The field is only cleared when the
  /// bridge accepted it, so a failed send never loses what was typed.
  Future<void> sendInboxReply() async {
    final text = inboxReply.text.trim();
    if (text.isEmpty || inboxSending) return;
    changeView(() {
      inboxSending = true;
      inboxError = null;
    });
    try {
      final result = await api.post('/api/inbox-send', {'text': text});
      final status = '${result['status'] ?? ''}';
      final problem = '${result['error'] ?? result['reason'] ?? ''}'.trim();
      if (!mounted) return;
      if (status == 'blocked' || status == 'ignored') {
        changeView(
          () => inboxError = problem.isEmpty
              ? 'The bridge could not accept this reply.'
              : problem,
        );
        return;
      }
      changeView(inboxReply.clear);
      await loadInboxFeed();
    } catch (e) {
      if (mounted) {
        changeView(
          () => inboxError = inboxFallback(e, 'Could not send this reply.'),
        );
      }
    } finally {
      if (mounted) changeView(() => inboxSending = false);
    }
  }

  Future<void> showInboxCleanup() async {
    changeView(() => actionError = null);
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, updateDialog) => AlertDialog(
          title: const Text('Request cleanup'),
          content: SingleChildScrollView(
            child: SizedBox(
              width: 520,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  requestCleanupCard(
                    onChanged: () {
                      if (dialogContext.mounted) updateDialog(() {});
                    },
                  ),
                  if (actionError != null) ...[
                    const SizedBox(height: 8),
                    Text(actionError!, style: const TextStyle(color: danger)),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }

  // ------------------------------------------------------------- inbox chrome

  num? inboxTotal() =>
      inboxNumber(inboxStats['total']) ??
      inboxFilterCount('all') ??
      inboxNumber(inboxView['count']);

  /// The count the feed reported for one chip id. Absent means the payload did
  /// not carry it; 0 is a real answer and must be shown.
  int? inboxFilterCount(String id) {
    for (final f in inboxFilters) {
      if ('${f['id'] ?? ''}' == id) {
        return inboxNumber(f['count'])?.toInt();
      }
    }
    return null;
  }

  /// A chip shows the count the feed reported in `filters`, which is the only
  /// source that knows about a group with no messages yet. The derivation from
  /// `views` stays behind it so an older payload never renders a blank chip.
  int? inboxChipCount(String id) {
    final reported = inboxFilterCount(id);
    if (reported != null) return reported;
    int sum(String kind) {
      final matches = inboxViews.where((v) => '${v['kind'] ?? ''}' == kind);
      if (matches.isEmpty) return -1;
      return matches.fold<int>(
        0,
        (total, v) => total + (inboxNumber(v['count']) ?? 0).toInt(),
      );
    }

    int? known(int value) => value < 0 ? null : value;
    return switch (id) {
      'all' => () {
        final statsTotal = inboxNumber(inboxStats['total']);
        if (statsTotal != null) return statsTotal.toInt();
        return inboxViews
            .where((v) => '${v['kind'] ?? ''}' == 'all')
            .map((v) => inboxNumber(v['count']))
            .firstOrNull
            ?.toInt();
      }(),
      'you' => known(sum('you')),
      'coordinators' => known(sum('coordinator')),
      'brain' => known(sum('brain')),
      'commands' => known(sum('command')),
      'attention' => known(
        (inboxNumber(inboxStats['needsYou']) ?? sum('attention')).toInt(),
      ),
      _ => null,
    };
  }

  Widget inboxCountPill(String value) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      color: raised,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: line2),
    ),
    child: Text(value, style: const TextStyle(fontSize: 11.5, color: muted)),
  );

  Widget inboxChip(String id, String label, {bool dot = false}) {
    final selected = inboxViewId == id;
    final count = inboxChipCount(id);
    return Material(
      key: ValueKey('inbox-chip-$id'),
      color: selected ? accentWash : Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: selected ? accent : line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: () => selectInboxView(id),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (dot) ...[
                Container(
                  width: 6,
                  height: 6,
                  decoration: const BoxDecoration(
                    color: accent,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: selected ? accent : muted,
                ),
              ),
              if (count != null) ...[
                const SizedBox(width: 6),
                Text(
                  '$count',
                  style: const TextStyle(fontSize: 12, color: faint),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget inboxChips() => Wrap(
    spacing: 8,
    runSpacing: 8,
    children: [
      inboxChip('all', 'All'),
      inboxChip('you', 'You'),
      inboxChip('coordinators', 'Coordinators'),
      inboxChip('brain', 'Brain'),
      inboxChip('commands', 'Commands'),
      inboxChip('attention', 'Needs you', dot: true),
    ],
  );

  /// Unified view, coordinator mark, brain, terminal, or a warning for a row
  /// that is nothing but a problem.
  Widget inboxViewAvatar(Map v, {double size = 32, bool mark = true}) {
    final kind = '${v['kind'] ?? ''}';
    if (mark && kind == 'coordinator') {
      return logoTile(providerBrand(v['provider']), size: size);
    }
    final (icon, tone, fill) = switch (kind) {
      'coordinator' => (Icons.code, accent, accentWash),
      'brain' => (Icons.psychology_outlined, accent, raised),
      'command' => (Icons.terminal, muted, raised),
      'attention' => (Icons.error_outline, warning, raised),
      'you' => (Icons.person_outline, muted, raised),
      _ => (Icons.chat_bubble_outline, accent, accentWash),
    };
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(size * .31),
        border: Border.all(color: line2),
      ),
      child: Icon(icon, size: size * .53, color: tone),
    );
  }

  Widget inboxViewRow(Map v) {
    final id = '${v['id'] ?? ''}';
    final selected = id == inboxViewId;
    final stamp = inboxStamp(inboxNumber(v['latestAt']));
    final preview = inboxText(v['preview']).replaceAll(RegExp(r'\s+'), ' ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        key: ValueKey('inbox-view-$id'),
        color: selected ? accentWash : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: selected ? accent : Colors.transparent),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => selectInboxView(id),
          child: SizedBox(
            height: 64,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Row(
                children: [
                  inboxViewAvatar(v),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                '${v['name'] ?? ''}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            if (stamp.isNotEmpty) ...[
                              const SizedBox(width: 6),
                              Text(
                                stamp,
                                style: const TextStyle(
                                  fontSize: 11,
                                  color: faint,
                                ),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          preview.isEmpty ? inboxViewSubtitle(v) : preview,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, color: muted),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  String inboxViewSubtitle(Map v) {
    final count = inboxNumber(v['count']);
    final detail = '${v['detail'] ?? ''}'.trim();
    if (detail.isNotEmpty) return detail;
    return count == null ? '' : '$count messages';
  }

  PopupMenuButton<String> inboxMoreMenu(Key key) => PopupMenuButton<String>(
    key: key,
    tooltip: 'More',
    onSelected: (value) {
      if (value == 'reload') {
        unawaited(loadInboxFeed());
      } else if (value == 'cleanup') {
        unawaited(showInboxCleanup());
      } else if (value == 'recovery') {
        unawaited(recoveryGuide());
      }
    },
    itemBuilder: (_) => const [
      PopupMenuItem(
        value: 'reload',
        child: Text('Reload', style: TextStyle(fontSize: 13)),
      ),
      PopupMenuItem(
        value: 'cleanup',
        child: Text('Request cleanup', style: TextStyle(fontSize: 13)),
      ),
      PopupMenuItem(
        value: 'recovery',
        child: Text('How recovery works', style: TextStyle(fontSize: 13)),
      ),
    ],
    child: const SizedBox(
      width: 34,
      height: 34,
      child: Icon(Icons.more_horiz, size: 18, color: muted),
    ),
  );

  Widget inboxSidebar() {
    final total = inboxTotal();
    return Container(
      decoration: const BoxDecoration(
        border: Border(right: BorderSide(color: hairline)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 16, 10, 12),
            child: Column(
              children: [
                Row(
                  children: [
                    const Text(
                      'Inbox',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (total != null) ...[
                      const SizedBox(width: 8),
                      inboxCountPill('${total.toInt()}'),
                    ],
                    const Spacer(),
                    IconButton(
                      key: const ValueKey('inbox-cleanup-settings'),
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Request cleanup',
                      icon: const Icon(Icons.filter_alt_outlined, size: 18),
                      onPressed: showInboxCleanup,
                    ),
                    IconButton(
                      key: const ValueKey('inbox-new-view'),
                      visualDensity: VisualDensity.compact,
                      tooltip: inboxOnlyText,
                      icon: const Icon(Icons.add, size: 19),
                      onPressed: null,
                    ),
                  ],
                ),
                gap(12),
                SizedBox(
                  height: 38,
                  child: TextField(
                    key: const ValueKey('inbox-search'),
                    onChanged: (value) {
                      changeView(() => inboxQuery = value);
                      inboxSearchTimer?.cancel();
                      inboxSearchTimer = Timer(
                        const Duration(milliseconds: 250),
                        () {
                          changeView(() => inboxEpoch++);
                          unawaited(loadInboxFeed());
                        },
                      );
                    },
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: 'Search conversations...',
                      prefixIcon: const Icon(
                        Icons.search,
                        size: 17,
                        color: faint,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(10),
                        borderSide: const BorderSide(color: line2),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(10),
                        borderSide: const BorderSide(color: line2),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(10),
                        borderSide: const BorderSide(color: accent),
                      ),
                    ),
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
                gap(12),
                Align(alignment: Alignment.centerLeft, child: inboxChips()),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              key: const ValueKey('inbox-views'),
              padding: const EdgeInsets.symmetric(horizontal: 10),
              children: [
                for (final v in inboxViews) inboxViewRow(v),
                if (inboxViews.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: small('No views to show.'),
                  ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: hairline)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '${total == null ? inboxViews.length : total.toInt()} conversations · Newest first',
                    style: const TextStyle(fontSize: 11, color: faint),
                  ),
                ),
                inboxMoreMenu(const ValueKey('inbox-more')),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget inboxPane() {
    // The pane owns the failure line so a stopped feed is never a blank screen,
    // whichever column is on screen.
    if (!inboxAttempted && !inboxLoading) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !inboxAttempted && !inboxLoading) {
          unawaited(loadInboxFeed());
        }
      });
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (inboxError != null) inboxErrorLine(),
        Expanded(
          child: LayoutBuilder(
            builder: (context, box) {
              final narrow = box.maxWidth < 700;
              final showConversation = !narrow || inboxShowConversation;
              return Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (!showConversation || !narrow)
                    SizedBox(
                      width: narrow ? box.maxWidth : 300,
                      child: inboxSidebar(),
                    ),
                  if (showConversation)
                    Expanded(
                      child: LayoutBuilder(
                        builder: (context, thread) {
                          // The thread's own content box, inside the timeline's
                          // horizontal padding. A bubble may take 70% of it, so
                          // the cap follows the window instead of a constant.
                          final content = (thread.maxWidth - 40).clamp(
                            0.0,
                            double.infinity,
                          );
                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              inboxHeader(narrow: narrow),
                              Expanded(
                                child: inboxTimeline(maxBubble: content * .7),
                              ),
                              inboxComposer(),
                            ],
                          );
                        },
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }

  Widget inboxErrorLine() => Container(
    key: const ValueKey('inbox-error'),
    margin: const EdgeInsets.fromLTRB(20, 12, 20, 0),
    padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
    decoration: BoxDecoration(
      color: sand,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: [
        const Icon(Icons.error_outline, size: 17, color: warning),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            inboxError ?? '',
            style: const TextStyle(fontSize: 12, color: warning),
          ),
        ),
        TextButton(
          key: const ValueKey('inbox-retry'),
          onPressed: () => unawaited(loadInboxFeed()),
          child: const Text('Retry'),
        ),
      ],
    ),
  );

  // ------------------------------------------------------------ conversation

  Widget inboxHeader({bool narrow = false}) {
    final view = inboxView;
    final count =
        inboxNumber(view['count']) ?? inboxNumber(inboxStats['total']);
    final started = inboxStarted(
      inboxNumber(view['firstAt']) ?? inboxNumber(inboxStats['firstAt']),
    );
    final subtitle = [
      if (count != null) '${count.toInt()} messages',
      if (started.isNotEmpty) started,
    ].join(' · ');
    return Container(
      key: const ValueKey('inbox-header'),
      padding: const EdgeInsets.fromLTRB(20, 12, 12, 12),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: hairline)),
      ),
      child: Row(
        children: [
          if (narrow)
            IconButton(
              key: const ValueKey('inbox-back'),
              tooltip: 'Back to views',
              icon: const Icon(Icons.chevron_left),
              onPressed: () => changeView(() => inboxShowConversation = false),
            ),
          inboxViewAvatar(view, size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${view['name'] ?? 'One conversation'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (subtitle.isNotEmpty) ...[
                  gap(3),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: muted),
                  ),
                ],
              ],
            ),
          ),
          IconButton(
            key: const ValueKey('inbox-bookmark'),
            tooltip: 'Saved marks are not available yet.',
            icon: const Icon(Icons.bookmark_border, size: 18),
            onPressed: null,
          ),
          const SizedBox(width: 4),
          OutlinedButton.icon(
            key: const ValueKey('inbox-details'),
            onPressed: () => unawaited(showInboxDetails()),
            icon: const Icon(Icons.info_outline, size: 15),
            label: const Text('Details', style: TextStyle(fontSize: 12)),
          ),
          const SizedBox(width: 4),
          inboxMoreMenu(const ValueKey('inbox-view-more')),
        ],
      ),
    );
  }

  /// Meta calls made for the owner's chat: fixed labels and timings only, never message text.
  Future<void> loadMetaEvents() async {
    try {
      final data = await api.get('/api/meta-timeline');
      final rows = data['events'];
      if (rows is! List) return;
      changeView(
        () => metaEvents = [
          for (final r in rows.whereType<Map>())
            if (inboxNumber(r['at']) != null &&
                _metaLabels.containsKey(r['stage']))
              {...r, 'meta': true},
        ],
      );
    } catch (_) {
      // Activity is extra detail; the thread still shows without it.
    }
  }

  Widget inboxMetaEvent(Map e) {
    final ms = (inboxNumber(e['durationMs']) ?? 0).clamp(0, 3600000);
    final took = ms < 1000
        ? '${ms.toInt()} ms'
        : '${(ms / 1000).toStringAsFixed(1)} s';
    final failed = e['status'] == 'failed';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Center(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              e['stage'] == 'heard'
                  ? Icons.mic_none_rounded
                  : Icons.auto_awesome_outlined,
              size: 13,
              color: failed ? warning : accent,
            ),
            const SizedBox(width: 6),
            Text(
              'Meta · ${_metaLabels[e['stage']]} · $took${failed ? ' · failed' : ''}',
              style: TextStyle(fontSize: 11, color: failed ? warning : muted),
            ),
          ],
        ),
      ),
    );
  }

  Widget inboxTimeline({required double maxBubble}) {
    final first = inboxMessages.isEmpty
        ? null
        : inboxNumber(inboxMessages.first['at']);
    final kind = '${inboxView['kind'] ?? inboxViewId}';
    final events = [
      if (first != null && (kind == 'all' || kind == 'brain'))
        for (final e in metaEvents)
          if (inboxNumber(e['at'])! >= first) e,
    ];
    // Messages keep their loaded order; each Meta line goes before the first
    // message that came after it.
    final entries = <Map>[];
    var k = 0;
    events.sort(
      (a, b) =>
          (inboxNumber(a['at']) ?? 0).compareTo(inboxNumber(b['at']) ?? 0),
    );
    for (final m in inboxMessages) {
      final at = inboxNumber(m['at']) ?? 0;
      while (k < events.length && inboxNumber(events[k]['at'])! < at) {
        entries.add(events[k++]);
      }
      entries.add(m);
    }
    entries.addAll(events.skip(k));
    final children = <Widget>[
      if (inboxNext != null)
        Center(
          child: TextButton(
            key: const ValueKey('inbox-earlier'),
            onPressed: inboxOlderLoading
                ? null
                : () => unawaited(loadInboxFeed(older: true)),
            child: Text(
              inboxOlderLoading ? 'Loading…' : 'Load earlier messages',
            ),
          ),
        ),
    ];
    String? day;
    for (final m in entries) {
      final at = inboxNumber(m['at']);
      if (at != null) {
        final label = dayLabel(at);
        if (label != day) {
          children.add(inboxDayPill(label));
          day = label;
        }
      }
      children.add(
        m['meta'] == true
            ? inboxMetaEvent(m)
            : inboxMessage(m, maxWidth: maxBubble),
      );
    }
    final approvals = List<Map>.from(status['approvals'] ?? [])
        .where((a) => a['alias'] == sessionBinding(inboxViewId)?['alias']);
    for (final a in approvals) {
      children.add(approvalTile(a));
    }
    if (entries.isEmpty) {
      children.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 24, 4, 24),
          child: small(
            inboxLoading
                ? 'Loading conversation…'
                : 'No messages in this view yet.',
          ),
        ),
      );
    }
    return ListView(
      key: const PageStorageKey('inbox-timeline'),
      controller: inboxScroll ??= ScrollController(),
      padding: const EdgeInsets.fromLTRB(20, 6, 20, 20),
      children: children,
    );
  }

  Widget inboxDayPill(String label) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 16),
    child: Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        decoration: BoxDecoration(
          color: raised,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: line2),
        ),
        child: Text(label, style: const TextStyle(fontSize: 12, color: muted)),
      ),
    ),
  );

  /// An attention entry is not a message: it keeps its own card with actions.
  Widget inboxMessage(Map m, {required double maxWidth}) =>
      inboxSource(m) == 'attention'
      ? inboxAttentionCard(m)
      : inboxRegularMessage(m, maxWidth: maxWidth);

  // One geometry for every message: the mark is a sibling of the bubble in the
  // same row, aligned with the bubble's top. A right message keeps one meta line
  // under its bubble; a left message keeps nothing under it, because its time
  // sits inside the bubble and everything else it knows lives in the details
  // panel the bubble can open.
  Widget inboxRegularMessage(Map m, {required double maxWidth}) {
    final key = '${m['key']}';
    final mine = inboxSource(m) == 'you';
    final rawMark = inboxMessageMark(m);
    final mark = rawMark == null
        ? null
        : KeyedSubtree(key: ValueKey('inbox-mark-$key'), child: rawMark);
    final bubble = Flexible(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: inboxMessageBubble(m, maxWidth: maxWidth),
      ),
    );
    final panel = mine ? null : inboxDetailsPanel(m, maxWidth: maxWidth);
    return Padding(
      key: ValueKey('inbox-message-$key'),
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: mine
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.start,
        children: [
          KeyedSubtree(
            // The brain used to have its own centred row. It is an ordinary
            // message now, but the key stays so nothing that looks for it
            // breaks while there is only one layout left.
            key: inboxSource(m) == 'brain'
                ? ValueKey('inbox-narration-$key')
                : null,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: mine
                  ? [
                      bubble,
                      if (mark != null) ...[const SizedBox(width: 8), mark],
                    ]
                  : [
                      if (mark != null) ...[mark, const SizedBox(width: 8)],
                      bubble,
                    ],
            ),
          ),
          if (mine) ...[const SizedBox(height: 6), inboxMetaLine(m)],
          if (panel != null) ...[
            const SizedBox(height: 6),
            Padding(
              // Aligned with the bubble, past the mark it sits beside.
              padding: const EdgeInsets.only(left: 36),
              child: panel,
            ),
          ],
        ],
      ),
    );
  }

  /// The mark that carries the source: the provider's own logo, the brain, a
  /// terminal for a command. Your own messages carry no mark at all - the chat
  /// they went through is not worth a logo on every row.
  Widget? inboxMessageMark(Map m) {
    final source = inboxSource(m);
    // Your own messages keep the channel mark and drop the channel word: the mark says which
    // messaging app the conversation runs on, and a printed "Telegram" said no more than that.
    // A message typed in the app still shows the channel it is delivered through; the meta line
    // carries the word "App" for those, so the difference is stated where it belongs.
    if (source == 'you') {
      return switch ('${m['channel'] ?? ''}') {
        'telegram' => logoTile('telegram', size: 28),
        'whatsapp' => logoTile('whatsapp', size: 28),
        _ => inboxGlyphMark(Icons.chat_bubble_outline),
      };
    }
    if (source == 'coordinator') {
      if (inboxProviderText(m).isEmpty) return inboxGlyphMark(Icons.code);
      return logoTile(inboxProviderBrand(m), size: 28);
    }
    return switch (inboxKind(m)) {
      'command' => inboxGlyphMark(Icons.terminal),
      'memory' ||
      'brief' ||
      'routing' => inboxGlyphMark(Icons.psychology_outlined, tone: accent),
      'attention' => inboxGlyphMark(Icons.error_outline, tone: warning),
      _ => inboxGlyphMark(Icons.info_outline),
    };
  }

  Widget inboxGlyphMark(IconData icon, {Color tone = muted}) => Container(
    width: 28,
    height: 28,
    decoration: BoxDecoration(
      color: raised,
      borderRadius: BorderRadius.circular(9),
      border: Border.all(color: line2),
    ),
    child: Icon(icon, size: 15, color: tone),
  );

  /// Exactly two surfaces, one per side: every left bubble is the same surface
  /// and every right bubble is the same surface, whatever the kind. A final is
  /// no different from a progress reply, and the marks keep their own colours
  /// while the bubbles do not.
  Widget inboxMessageBubble(Map m, {required double maxWidth}) {
    final key = '${m['key']}';
    final mine = inboxSource(m) == 'you';
    final command = inboxKind(m) == 'command';
    final voice = inboxDuration(m['voice']);
    final voiceNote = mine && (inboxKind(m) == 'voice' || m['voice'] is Map);
    final text = mine ? inboxText(m['text']) : inboxBody(m['text']);
    final body = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (voiceNote) ...[
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.mic_none, size: 13, color: muted),
              const SizedBox(width: 6),
              Text(
                voice.isEmpty ? 'Voice note' : 'Voice note · $voice',
                style: const TextStyle(fontSize: 11.5, color: muted),
              ),
            ],
          ),
          const SizedBox(height: 6),
        ],
        if (command) ...[
          // A command is a terminal transcript, so its name sits with the
          // body rather than in the one meta line every other message uses.
          Text(
            '${m['kindLabel'] ?? inboxDefaultKindLabel('command')}',
            style: const TextStyle(
              fontSize: 11.5,
              color: muted,
              fontFamily: 'monospace',
            ),
          ),
          const SizedBox(height: 6),
          SelectableText(
            text,
            style: const TextStyle(
              fontSize: 12.5,
              height: 1.45,
              color: ink,
              fontFamily: 'monospace',
            ),
          ),
        ] else
          ChatMessageText(text, size: 13.5),
      ],
    );
    final fill = mine ? accentWash : raised;
    final border = mine ? accent.withValues(alpha: .25) : line2;
    if (mine) {
      return Container(
        key: ValueKey('inbox-bubble-$key'),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: border),
        ),
        child: body,
      );
    }
    final at = inboxNumber(m['at']);
    return Container(
      key: ValueKey('inbox-bubble-$key'),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: border),
      ),
      child: Stack(
        children: [
          // The reserved strip at the bottom holds the quiet details control on
          // the left and the time on the right, both inside the bubble.
          Padding(padding: const EdgeInsets.only(bottom: 22), child: body),
          Positioned(left: 0, bottom: 0, child: inboxDetailsButton(m)),
          if (at != null)
            Positioned(
              right: 0,
              bottom: 3,
              child: Text(
                clock(at),
                style: const TextStyle(fontSize: 11, color: muted),
              ),
            ),
        ],
      ),
    );
  }

  /// A small, quiet toggle: no filled background, 15px, faint.
  Widget inboxDetailsButton(Map m) => Tooltip(
    message: 'Details',
    child: InkWell(
      key: ValueKey('inbox-details-${m['key']}'),
      borderRadius: BorderRadius.circular(6),
      onTap: () => toggleInboxDetails('${m['key']}'),
      child: const Padding(
        padding: EdgeInsets.all(3),
        child: Icon(Icons.info_outline, size: 15, color: faint),
      ),
    ),
  );

  void toggleInboxDetails(String key) {
    changeView(() {
      if (!inboxExpanded.remove(key)) inboxExpanded.add(key);
    });
  }

  /// Everything the clean surface leaves out, on demand and only for the
  /// message it belongs to: the provider in words, the session, the kind, the
  /// delivery state, the mode the body carried, the item and the request.
  Widget? inboxDetailsPanel(Map m, {required double maxWidth}) {
    if (!inboxExpanded.contains('${m['key']}')) return null;
    final rows = inboxDetailRows(m);
    if (rows.isEmpty) return null;
    return Container(
      key: ValueKey('inbox-details-panel-${m['key']}'),
      constraints: BoxConstraints(
        maxWidth: maxWidth > 36 ? maxWidth - 36 : maxWidth,
      ),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: raised,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: line2),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final row in rows)
            Padding(
              padding: EdgeInsets.only(bottom: row == rows.last ? 0 : 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 62,
                    child: Text(
                      row.$1,
                      style: const TextStyle(fontSize: 11, color: faint),
                    ),
                  ),
                  Expanded(
                    child: Text(row.$2, style: const TextStyle(fontSize: 12)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  List<(String, String)> inboxDetailRows(Map m) {
    final provider = inboxProviderText(m);
    final session = inboxSessionText(m);
    final kind = '${m['kindLabel'] ?? inboxDefaultKindLabel(inboxKind(m))}';
    final state = inboxDeliveryWord(m['delivery']);
    final mode = inboxMetadata(m['text']).mode;
    final item = inboxNumber(m['itemRef']);
    final request = '${m['requestId'] ?? ''}'.trim();
    return [
      if (provider.isNotEmpty) ('Provider', provider),
      if (session.isNotEmpty) ('Session', session),
      if (kind.isNotEmpty) ('Kind', kind),
      if (state.isNotEmpty) ('Delivery', state),
      if (mode.isNotEmpty) ('Mode', mode),
      if (item != null) ('Item', '${item.toInt()}'),
      if (request.isNotEmpty) ('Request', request),
    ];
  }

  /// The one line under a right bubble: the time and the ticks, with the word
  /// "App" only when the reply was typed here rather than in a chat. The
  /// channel word is gone - it is already known.
  List<String> inboxMetaParts(Map m) {
    final at = inboxNumber(m['at']);
    final time = at == null ? '' : clock(at);
    final ticks = inboxTicks(m['delivery']);
    final origin = '${m['origin'] ?? ''}';
    return [
      if (origin == 'app') 'App',
      if (time.isNotEmpty) [time, if (ticks.isNotEmpty) ticks].join(' '),
    ];
  }

  Widget inboxMetaLine(Map m) {
    final parts = inboxMetaParts(m);
    if (parts.isEmpty) return const SizedBox.shrink();
    return ConstrainedBox(
      key: ValueKey('inbox-attribution-${m['key']}'),
      constraints: const BoxConstraints(maxWidth: 560),
      child: Text(
        parts.join(' · '),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        textAlign: TextAlign.right,
        style: const TextStyle(fontSize: 11.5, color: faint),
      ),
    );
  }

  String inboxDefaultKindLabel(String kind) => switch (kind) {
    'working' => 'Working',
    'update' => 'Update',
    'final' => 'Final',
    'command' => 'Command',
    'memory' => 'Memory',
    'brief' => 'Brief',
    'routing' => 'Routing',
    'voice' => 'Voice',
    'text' => 'Reply',
    _ => 'Notice',
  };

  // ---------------------------------------------------------------- attention

  Widget inboxAttentionCard(Map m) {
    final key = '${m['key']}';
    final review = m['needsReview'] == true;
    final tone = review ? danger : accent;
    final at = inboxNumber(m['at']);
    final title = '${m['kindLabel'] ?? (review ? 'Needs you' : 'Notice')}';
    final text = inboxText(m['text']);
    return Padding(
      key: ValueKey('inbox-message-$key'),
      padding: const EdgeInsets.only(bottom: 16),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        // A differing left edge cannot carry a radius, so the accent is its own
        // strip inside the card instead of a non-uniform border.
        child: Container(
          decoration: BoxDecoration(
            color: raised,
            border: Border.all(color: line2),
          ),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(width: 3, color: tone),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(11, 12, 12, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(
                              review ? Icons.error_outline : Icons.info_outline,
                              size: 15,
                              color: tone,
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 12.5,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            if (at != null)
                              Text(
                                clock(at),
                                style: const TextStyle(
                                  fontSize: 11.5,
                                  color: faint,
                                ),
                              ),
                          ],
                        ),
                        if (text.isNotEmpty) ...[
                          gap(6),
                          Text(
                            text,
                            style: const TextStyle(
                              fontSize: 12.5,
                              color: muted,
                              height: 1.45,
                            ),
                          ),
                        ],
                        inboxAttentionActions(m, key),
                      ],
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

  /// Only the actions this entry can actually honour are offered: an orphan
  /// voice note is reviewed by destination, a tracked request by its exact
  /// status, and a request whose id may belong to another chat is never used to
  /// open diagnostics.
  Widget inboxAttentionActions(Map m, String key) {
    final requestId = '${m['requestId'] ?? ''}';
    final binding = '${m['bindingId'] ?? ''}';
    final destination = m['destination'];
    final orphanVoice = m['canReviewOrphan'] == 1 && destination is String;
    final requestStatus = '${m['status'] ?? ''}';
    final canReviewRequest =
        !orphanVoice &&
        requestId.isNotEmpty &&
        requestStatus.isNotEmpty &&
        m['canClose'] == true;
    final approval = m['approval'];
    final updateId = '${m['updateId'] ?? ''}';
    final commandId = '${m['commandId'] ?? ''}';
    final buttons = <Widget>[
      if (approval is Map)
        TextButton(
          key: ValueKey('inbox-approval-$key'),
          onPressed: () => unawaited(openInboxApproval(approval)),
          child: const Text('Open approval', style: TextStyle(fontSize: 12)),
        ),
      if (orphanVoice || canReviewRequest)
        TextButton(
          key: ValueKey('inbox-review-$key'),
          onPressed: busy
              ? null
              : () => unawaited(reviewInboxAttention(m, voice: orphanVoice)),
          child: const Text('Mark reviewed', style: TextStyle(fontSize: 12)),
        ),
      if (requestId.isNotEmpty && binding != 'unassigned-voice')
        TextButton(
          key: ValueKey('inbox-timeline-$key'),
          onPressed: () => unawaited(requestTimeline(requestId)),
          child: const Text(
            'Timing and delivery',
            style: TextStyle(fontSize: 12),
          ),
        ),
      if (updateId.isNotEmpty)
        TextButton(
          key: ValueKey('inbox-update-$key'),
          onPressed: () => unawaited(readLocalUpdate(updateId)),
          child: const Text('Open update', style: TextStyle(fontSize: 12)),
        ),
      if (commandId.isNotEmpty)
        TextButton(
          key: ValueKey('inbox-command-$key'),
          onPressed: () => selectInboxView('commands'),
          child: const Text('Open commands', style: TextStyle(fontSize: 12)),
        ),
    ];
    if (buttons.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Wrap(spacing: 4, children: buttons),
    );
  }

  Future<void> openInboxApproval(Map a) => showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Waiting for you'),
      content: SizedBox(width: 400, child: approvalTile(a)),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Done'),
        ),
      ],
    ),
  );

  Future<void> reviewInboxAttention(Map m, {required bool voice}) async {
    final requestId = '${m['requestId'] ?? ''}';
    if (requestId.isEmpty) return;
    if (voice) {
      if (!await confirm(
        'Mark this voice note reviewed?',
        'This removes it from Needs you. Its original failure and diagnostics stay saved.',
        actionLabel: 'Mark reviewed',
      )) {
        return;
      }
      if (!mounted) return;
      await post('/api/voice-attention-review', {
        'audioId': requestId,
        'destination': '${m['destination']}',
        'confirmed': true,
      });
    } else {
      if (!await confirm(
        'Close this request after review?',
        'Tracking ends only for this request. History is kept; native work is not stopped or marked successful.',
        actionLabel: 'Mark reviewed',
      )) {
        return;
      }
      if (!mounted) return;
      await post('/api/request-review', {
        'requestId': requestId,
        'expectedStatus': '${m['status']}',
        'confirmed': true,
      });
    }
    if (mounted && actionError == null) await loadInboxFeed();
  }

  // --------------------------------------------------------------- composer

  Widget inboxComposer() {
    final canSend = !inboxSending && inboxReply.text.trim().isNotEmpty;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 14, 12),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: hairline)),
      ),
      child: Row(
        children: [
          IconButton(
            key: const ValueKey('inbox-composer-new'),
            tooltip: inboxOnlyText,
            onPressed: null,
            icon: const Icon(Icons.add, size: 20),
            style: IconButton.styleFrom(
              minimumSize: const Size(38, 38),
              padding: EdgeInsets.zero,
              shape: const CircleBorder(),
              side: const BorderSide(color: line),
              foregroundColor: faint,
              disabledForegroundColor: faint,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Tooltip(
              message: inboxOnlyText,
              child: TextField(
                key: const ValueKey('inbox-composer-field'),
                controller: inboxReply,
                enabled: !inboxSending,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => unawaited(sendInboxReply()),
                onChanged: (_) => changeView(() {}),
                decoration: const InputDecoration(
                  isDense: true,
                  hintText: 'Type a reply...',
                ),
                style: const TextStyle(fontSize: 13.5),
              ),
            ),
          ),
          const SizedBox(width: 8),
          IconButton(
            key: const ValueKey('inbox-composer-mic'),
            tooltip: inboxOnlyText,
            onPressed: null,
            icon: const Icon(Icons.mic_none, size: 20),
            style: IconButton.styleFrom(
              foregroundColor: faint,
              disabledForegroundColor: faint,
            ),
          ),
          const SizedBox(width: 6),
          IconButton(
            key: const ValueKey('inbox-composer-send'),
            tooltip: inboxSendNote,
            onPressed: canSend ? () => unawaited(sendInboxReply()) : null,
            icon: const Icon(Icons.arrow_upward, size: 18),
            style: IconButton.styleFrom(
              minimumSize: const Size(38, 38),
              padding: EdgeInsets.zero,
              shape: const CircleBorder(),
              backgroundColor: accent,
              foregroundColor: accentInk,
              disabledBackgroundColor: accent.withValues(alpha: .4),
              disabledForegroundColor: accentInk.withValues(alpha: .7),
            ),
          ),
        ],
      ),
    );
  }

  // ------------------------------------------------------- details and dialogs

  Future<void> showInboxDetails() async {
    final id = '${inboxView['id'] ?? inboxViewId}';
    if ('${inboxView['kind'] ?? ''}' == 'coordinator' ||
        sessionBinding(id) != null) {
      await showSessionInfo(inboxView);
      return;
    }
    final total = inboxNumber(inboxStats['total']);
    final firstAt = inboxNumber(inboxStats['firstAt']);
    final lastAt = inboxNumber(inboxStats['lastAt']);
    final needsYou = inboxNumber(inboxStats['needsYou']);
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Conversation'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final row in [
                ('View', '${inboxView['name'] ?? 'One conversation'}'),
                if (total != null) ('Messages', '${total.toInt()}'),
                if (firstAt != null) ('Started', clock(firstAt)),
                if (lastAt != null) ('Latest', clock(lastAt)),
                if (needsYou != null) ('Needs you', '${needsYou.toInt()}'),
                ('Loaded here', '${inboxMessages.length}'),
              ])
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 96,
                        child: Text(
                          row.$1,
                          style: const TextStyle(fontSize: 11, color: faint),
                        ),
                      ),
                      Expanded(
                        child: Text(
                          row.$2,
                          style: const TextStyle(fontSize: 12.5),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
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
    final id = '${g['id']}';
    final b = sessionBinding(id);
    final jobs = allJobs.where((j) => sessionKey(j) == id).toList()
      ..sort(
        (a, b) => ((b['updated_at'] ?? jobAt(b)) as num).compareTo(
          (a['updated_at'] ?? jobAt(a)) as num,
        ),
      );
    final job =
        jobs.where((j) => j['id'] == inboxRequestSelected).firstOrNull ??
        jobs.firstOrNull;
    final destinations = <String>{
      for (final j in jobs)
        if ('${j['destination'] ?? ''}'.isNotEmpty)
          '${j['destination']}'.startsWith('tg:') ? 'Telegram' : 'WhatsApp',
    };
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          '${g['name'] ?? ''}',
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
              onChanged: (selected) {
                changeView(() => inboxRequestSelected = selected);
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
            state:
                ['uncertain', 'failed'].contains(job['status']) ||
                    job['outcome'] == 'blocked'
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
                  await loadInboxFeed();
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

  // Settings: a fixed sub-nav that switches panes. One section is on screen at
  // a time, so the nav highlight always names what you are actually reading.

  /// Rounded tile behind a settings icon. Only the section heading gets the warm
  /// accent tile; the rows under it are neutral with a light icon, which is what
  /// stops a page of settings reading as a wall of orange.
  ///
  /// The row tile is deliberately not square. Measured off the design reference
  /// it is 53 x 45, and that height is what makes the card heights come out
  /// right: with a 52-square tile the "Open at login" card grows to 87pt against
  /// the reference's 76, because the tile rather than the text starts setting the
  /// row height. The heading tile above is the larger, square one (56).
  Widget settingsIconTile(
    IconData icon, {
    double size = 53,
    double height = 45,
    bool accentTile = false,
  }) => Container(
    width: size,
    height: height,
    decoration: BoxDecoration(
      color: accentTile ? const Color(0x28ff6b2c) : const Color(0x0fffffff),
      borderRadius: BorderRadius.circular(size * .3),
    ),
    child: Icon(icon, size: size * .46, color: accentTile ? accent : ink),
  );

  /// Small state word. Used where a full [tag] would compete with a control.
  Widget settingsChip(String text, {Color color = muted}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .14),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      text,
      style: TextStyle(
        fontSize: 10.5,
        fontWeight: FontWeight.w600,
        color: color,
      ),
    ),
  );

  Widget settingsDot(Color color) => Container(
    width: 7,
    height: 7,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );

  /// Heading for the selected section: tile, title, one line of context, and
  /// the section's own status on the right, where it describes the section
  /// rather than one row inside it.
  Widget settingsHeading(
    String title,
    String subtitle,
    IconData icon, {
    Widget? status,
  }) => Padding(
    // 30, not 18: measured off the reference, where the first card sits 30.5pt
    // below the heading tile. At 18 the heading looked like it was crowding the
    // card it belongs to.
    padding: const EdgeInsets.only(bottom: 30),
    child: Row(
      children: [
        settingsIconTile(icon, size: 56, height: 56, accentTile: true),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontSize: 25,
                  height: 1.15,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -.5,
                ),
              ),
              gap(5),
              Text(
                subtitle,
                style: const TextStyle(fontSize: 13, height: 1.4, color: muted),
              ),
            ],
          ),
        ),
        if (status != null) ...[const SizedBox(width: 16), status],
      ],
    ),
  );

  /// One setting: icon, title, the line that says what it does, the control,
  /// and any detail that only matters once the setting is on.
  Widget settingCard(
    IconData icon,
    String title,
    String detail, {
    Widget? control,
    List<Widget> footer = const [],
  }) => Container(
    width: double.infinity,
    // 6, not 10: the reference stacks its cards 6.3pt apart. Ten left visible
    // gaps between cards while the cards themselves already had generous
    // internal padding, so the page read as loose and long at the same time.
    margin: const EdgeInsets.only(bottom: 6),
    padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
    decoration: BoxDecoration(
      color: toneCharcoal,
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: line2),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            settingsIconTile(icon),
            const SizedBox(width: 24),
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
                  gap(3),
                  Text(
                    detail,
                    style: const TextStyle(
                      fontSize: 12.5,
                      height: 1.45,
                      color: ink2,
                    ),
                  ),
                ],
              ),
            ),
            if (control != null) ...[const SizedBox(width: 16), control],
          ],
        ),
        if (footer.isNotEmpty) ...[
          gap(14),
          // Inset to the same column the title starts in: card padding + tile
          // + gap, so it tracks the tile size above rather than being a number
          // that has to be remembered separately.
          Padding(
            padding: const EdgeInsets.only(left: 97),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: footer,
            ),
          ),
        ],
      ],
    ),
  );

  /// Quiet strip for a caveat that belongs to the section, not to one row.
  Widget settingsNote(
    String text, {
    IconData icon = Icons.info_outline_rounded,
  }) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(top: 4),
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
    decoration: BoxDecoration(
      color: const Color(0x0ff4f1ea),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: hairline),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: muted),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(fontSize: 12.5, height: 1.45, color: ink2),
          ),
        ),
      ],
    ),
  );

  /// Heading for a group of cards inside one section, with its own one-line
  /// explanation so a section can hold more than one group.
  Widget settingsSubheading(String title, String detail) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        title,
        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
      gap(4),
      small(detail),
    ],
  );

  Widget settingsNavItem(_SettingsSection section, bool on) => Padding(
    padding: const EdgeInsets.only(bottom: 3),
    child: Material(
      color: on ? accentWash : Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(
          color: on ? accent.withValues(alpha: .5) : Colors.transparent,
        ),
      ),
      child: InkWell(
        key: Key('settings-tab-${section.id}'),
        borderRadius: BorderRadius.circular(10),
        onTap: () => changeView(() => settingsTab = section.id),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
          child: Row(
            children: [
              Icon(section.icon, size: 18, color: on ? accent : muted),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  section.title,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: on ? FontWeight.w600 : FontWeight.w500,
                    color: on ? ink : ink2,
                  ),
                ),
              ),
              if (section.badge != null) ...[
                const SizedBox(width: 8),
                KeyedSubtree(
                  key: Key('settings-badge-${section.id}'),
                  child: section.badge!,
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );

  Widget settingsPane() {
    final sections = settingsSections();
    final current = sections.firstWhere(
      (s) => s.id == settingsTab,
      orElse: () => sections.first,
    );
    final nav = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Settings',
          style: Theme.of(context).textTheme.headlineLarge
              ?.copyWith(fontSize: 30, height: 1.1, letterSpacing: -.7),
        ),
        gap(9),
        Text(
          'Manage your $computer, remote access, and updates for FarFromDesk.',
          style: const TextStyle(fontSize: 13, height: 1.5, color: muted),
        ),
        gap(20),
        Container(
          padding: const EdgeInsets.all(7),
          decoration: BoxDecoration(
            color: toneCharcoal,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: line2),
          ),
          child: Column(
            children: [
              for (final s in sections) settingsNavItem(s, s.id == current.id),
            ],
          ),
        ),
      ],
    );
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        settingsHeading(
          current.title,
          current.subtitle,
          current.icon,
          status: current.status,
        ),
        ...current.cards,
      ],
    );
    return LayoutBuilder(
      builder: (context, box) {
        if (box.maxWidth < 820) {
          // Below this the tab column would squeeze the cards, so the nav
          // stacks on top instead of disappearing the way the old one did.
          return SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 20, 24, 34),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [nav, gap(26), body],
            ),
          );
        }
        // The nav is its own scroll column so it stays put while the pane scrolls: it
        // is the only way to reach a section, so it must never scroll away.
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              width: 258,
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(26, 22, 24, 30),
                child: nav,
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                // 30 top, 24 right. The top matches the reference, which starts
                // its first card 30.5pt below the pane edge. The right gutter
                // was 36 against the reference's 24.3, so a full 12pt of
                // content width was being thrown away - and the left stays 0
                // because the nav column's own padding already sets that gap.
                padding: const EdgeInsets.fromLTRB(0, 30, 24, 40),
                child: Align(
                  alignment: Alignment.topLeft,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 980),
                    child: body,
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

const _metaLabels = {
  'sorted': 'Read your message',
  'briefed': 'Morning brief',
  'scheduled': 'Reminder',
  'heard': 'Voice transcription',
  'contracted': 'Task contract',
  'stuck': 'Stuck notice',
};

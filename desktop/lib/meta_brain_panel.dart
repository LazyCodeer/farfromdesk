import 'dart:async';

import 'package:flutter/material.dart';

import 'bridge_theme.dart';
import 'gateway.dart';
import 'memory_panel.dart';

const defaultMetaBrainModel = 'muse-wonder-1.0';
const fallbackMetaBrainModels = [
  'muse-spark-1.3',
  'muse-spark-1.2',
  'muse-spark-1.1',
  defaultMetaBrainModel,
];

/// Small (i) button whose tooltip says what a feature does and why.
Widget infoTip(String message, {String label = 'About this'}) => Tooltip(
  message: message,
  preferBelow: true,
  waitDuration: const Duration(milliseconds: 250),
  constraints: const BoxConstraints(maxWidth: 280),
  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
  textStyle: const TextStyle(fontSize: 12, height: 1.45, color: ink),
  decoration: BoxDecoration(
    color: dialogColor,
    borderRadius: BorderRadius.circular(10),
    border: Border.all(color: line2),
  ),
  child: Semantics(
    label: label,
    button: true,
    child: const Padding(
      padding: EdgeInsets.all(4),
      child: Icon(Icons.info_outline_rounded, size: 15, color: muted),
    ),
  ),
);

/// The Brain page. Native Settings is the only credential input; status
/// responses never contain a key.
class MetaBrainPanel extends StatefulWidget {
  final Gateway gateway;
  final Map<String, dynamic> saved;
  final Future<void> Function() onSaved;
  final VoidCallback? openItems;
  const MetaBrainPanel({
    super.key,
    required this.gateway,
    required this.saved,
    required this.onSaved,
    this.openItems,
  });
  @override
  State<MetaBrainPanel> createState() => _MetaBrainPanelState();
}

class _MetaBrainPanelState extends State<MetaBrainPanel> {
  final keyInput = TextEditingController();
  late bool enabled, routing, summaries, management, learn, taskContracts;
  late String model, failure;
  late Set<String> providers;
  bool saving = false, replacingKey = false;
  String? message, taskMessage;
  List<Map<String, dynamic>>? tasks;
  List<Map<String, dynamic>> workItems = [];
  List<Map<String, dynamic>> metaActivity = [];
  bool activityLoading = true, activityBusy = false, activityError = false;
  Timer? activityTimer;
  @override
  void initState() {
    super.initState();
    final s = widget.saved;
    enabled = s['enabled'] == true;
    routing = s['allowRouting'] == true;
    summaries = s['allowStatus'] != false;
    management = s['allowManagement'] == true;
    model = s['model'] as String? ?? defaultMetaBrainModel;
    failure = s['failure'] as String? ?? 'legacy';
    providers = Set<String>.from(s['providers'] ?? []);
    learn = s['learn'] != false;
    taskContracts = s['taskContracts'] != false;
    loadActivity();
    activityTimer = Timer.periodic(
      const Duration(seconds: 15),
      (_) => loadActivity(),
    );
  }

  @override
  void dispose() {
    activityTimer?.cancel();
    keyInput.clear();
    keyInput.dispose();
    super.dispose();
  }

  Future<void> loadActivity() async {
    if (activityBusy) return;
    activityBusy = true;
    try {
      final data = await widget.gateway.get('/api/meta-timeline');
      final rows = data['events'];
      if (rows is! List) throw const FormatException('Invalid activity');
      final parsed = rows
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .where((row) {
            final duration = row['durationMs'];
            final at = row['at'];
            return {
                  'sorted',
                  'briefed',
                  'scheduled',
                  'heard',
                }.contains(row['stage']) &&
                {'completed', 'failed'}.contains(row['status']) &&
                duration is num &&
                duration.isFinite &&
                duration >= 0 &&
                duration <= 3600000 &&
                at is num &&
                at.isFinite &&
                at >= 0 &&
                at <= 8640000000000000;
          })
          .take(30)
          .toList();
      if (mounted) {
        setState(() {
          metaActivity = parsed;
          activityLoading = false;
          activityError = false;
        });
      }
    } catch (_) {
      // Never show stale activity as belonging to the currently selected chat.
      if (mounted) {
        setState(() {
          metaActivity = [];
          activityLoading = false;
          activityError = true;
        });
      }
    } finally {
      activityBusy = false;
    }
  }

  Widget activityTab() {
    final localizations = MaterialLocalizations.of(context);
    const labels = {
      'sorted': 'Message interpretation',
      'briefed': 'Morning brief',
      'scheduled': 'Reminder interpretation',
      'heard': 'Voice transcription',
    };
    return box(
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Meta activity',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    SizedBox(height: 4),
                    Text(
                      'Meta API calls in this chat, not task outcomes. No message text is shown.',
                      style: TextStyle(fontSize: 12, color: muted),
                    ),
                  ],
                ),
              ),
              TextButton(
                onPressed: activityBusy ? null : loadActivity,
                child: const Text('Refresh'),
              ),
            ],
          ),
          const Divider(color: line2),
          if (activityLoading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text(
                'Loading activity...',
                style: TextStyle(color: muted),
              ),
            )
          else if (activityError)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text(
                'Could not load Meta activity. Try refresh.',
                style: TextStyle(color: muted),
              ),
            )
          else if (metaActivity.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text(
                'No Meta calls recorded in this chat yet.',
                style: TextStyle(color: muted),
              ),
            )
          else
            for (final event in metaActivity)
              Builder(
                builder: (context) {
                  final name = labels[event['stage']]!;
                  final at = DateTime.fromMillisecondsSinceEpoch(
                    (event['at'] as num).toInt(),
                  ).toLocal();
                  final time = localizations.formatTimeOfDay(
                    TimeOfDay.fromDateTime(at),
                  );
                  final day = DateUtils.isSameDay(at, DateTime.now())
                      ? 'Today'
                      : localizations.formatShortDate(at);
                  final ms = (event['durationMs'] as num).clamp(0, 3600000);
                  final duration = ms < 1000
                      ? '${ms.toInt()} ms'
                      : '${(ms / 1000).toStringAsFixed(1)} s';
                  final succeeded = event['status'] == 'completed';
                  final status = succeeded ? 'API responded' : 'Request failed';
                  return Semantics(
                    label: '$name, $day, $time, $duration, $status',
                    excludeSemantics: true,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Row(
                        children: [
                          Container(
                            width: 34,
                            height: 34,
                            decoration: BoxDecoration(
                              color: accentWash,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Icon(
                              event['stage'] == 'heard'
                                  ? Icons.mic_none_rounded
                                  : Icons.auto_awesome_outlined,
                              color: accentSoft,
                              size: 17,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  name,
                                  style: const TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                const SizedBox(height: 3),
                                Text(
                                  '$day, $time',
                                  style: const TextStyle(
                                    color: muted,
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 12),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text(
                                duration,
                                style: const TextStyle(fontSize: 12),
                              ),
                              const SizedBox(height: 3),
                              Text(
                                status,
                                style: TextStyle(
                                  color: succeeded ? success : warning,
                                  fontSize: 11,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
        ],
      ),
    );
  }

  Future<void> save({bool remove = false}) async {
    setState(() {
      saving = true;
      message = null;
    });
    try {
      await widget.gateway.post('/api/meta-brain', {
        'policy': {
          'enabled': enabled,
          'model': model,
          'allowRouting': routing,
          'allowStatus': summaries,
          'allowManagement': management,
          'providers': providers.toList(),
          'failure': failure,
          'notes': widget.saved['notes'] as String? ?? '',
          'learn': learn,
          'taskContracts': taskContracts,
        },
        if (!remove && keyInput.text.isNotEmpty) 'key': keyInput.text,
        if (remove) 'removeKey': true,
      });
      if (mounted) keyInput.clear();
      await widget.onSaved();
      if (mounted) {
        setState(() {
          replacingKey = false;
          message = 'Saved. No API call was made.';
        });
      }
    } catch (_) {
      // Do not surface raw network errors that might echo submitted credentials.
      if (mounted) {
        setState(() {
          message = 'Could not save. Check the key and background service.';
        });
      }
    } finally {
      if (mounted) {
        keyInput.clear();
        setState(() => saving = false);
      }
    }
  }

  Future<void> loadTasks() async {
    try {
      final data = await widget.gateway.get('/api/meta-brain/tasks?fresh=1');
      if (mounted) {
        setState(() {
          workItems = (data['workItems'] as List? ?? [])
              .map((t) => Map<String, dynamic>.from(t as Map))
              .toList();
          tasks = (data['tasks'] as List)
              .map((t) => Map<String, dynamic>.from(t as Map))
              .toList();
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() => taskMessage = 'Could not load the task history.');
      }
    }
  }

  Future<void> verify(Map<String, dynamic> task) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Verify this task is complete?'),
        content: Text(
          'Confirm only after reviewing the work and its evidence. A proxy report alone is not owner verification.\n\n${task['original']}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('I verified it'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await widget.gateway.post('/api/meta-brain/verify', {
        'requestId': task['id'],
        'confirmed': true,
      });
      await loadTasks();
    } catch (_) {
      if (mounted) {
        setState(() => message = 'Verification could not be saved.');
      }
    }
  }

  Widget box(Widget child) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(bottom: 12),
    padding: const EdgeInsets.fromLTRB(22, 20, 22, 20),
    decoration: BoxDecoration(
      color: toneCharcoal,
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: hairline),
    ),
    child: Material(color: Colors.transparent, child: child),
  );

  Widget heading(String title, String tip, {String? subtitle, Widget? end}) =>
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(width: 2),
                    infoTip(tip, label: 'About $title'),
                  ],
                ),
                if (subtitle != null)
                  Text(
                    subtitle,
                    style: const TextStyle(fontSize: 12, color: muted),
                  ),
              ],
            ),
          ),
          ?end,
        ],
      );

  Widget row(String title, String detail, Widget control, {String? tip}) =>
      Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: hairline)),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          title,
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      if (tip != null) infoTip(tip, label: 'About $title'),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    detail,
                    style: const TextStyle(
                      fontSize: 12,
                      height: 1.45,
                      color: muted,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 16),
            control,
          ],
        ),
      );

  Widget calloutNote(IconData icon, String bold, String text) => Container(
    margin: const EdgeInsets.only(top: 14),
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
    decoration: BoxDecoration(
      color: canvas,
      borderRadius: BorderRadius.circular(14),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: muted),
        const SizedBox(width: 10),
        Expanded(
          child: Text.rich(
            TextSpan(
              children: [
                if (bold.isNotEmpty)
                  TextSpan(
                    text: '$bold ',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                TextSpan(text: text),
              ],
            ),
            style: const TextStyle(fontSize: 12.5, height: 1.5, color: muted),
          ),
        ),
      ],
    ),
  );

  Widget saveRow(String label) => Padding(
    padding: const EdgeInsets.only(top: 16),
    child: Wrap(
      spacing: 12,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        FilledButton(
          onPressed: saving ? null : () => save(),
          child: Text(label),
        ),
        Text(
          message ?? "Saved on this computer. Saving doesn't call Meta.",
          style: const TextStyle(fontSize: 12, color: muted),
        ),
      ],
    ),
  );

  Widget toggle(
    String title,
    String detail,
    bool value,
    ValueChanged<bool> change,
  ) => SwitchListTile(
    contentPadding: EdgeInsets.zero,
    title: Text(
      title,
      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
    ),
    subtitle: Text(
      detail,
      style: const TextStyle(fontSize: 12, height: 1.45, color: muted),
    ),
    value: value,
    onChanged: saving ? null : change,
  );

  Widget keyField() => TextField(
    controller: keyInput,
    obscureText: true,
    enableSuggestions: false,
    autocorrect: false,
    decoration: const InputDecoration(
      labelText: 'Meta Model API key',
      hintText: 'Paste your key',
    ),
  );

  Widget pageHeading(String title, String description) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 3),
        Text(description, style: const TextStyle(fontSize: 12, color: muted)),
      ],
    ),
  );

  Widget flowStep(String number, String title, String detail) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          Text(
            number,
            style: const TextStyle(
              fontSize: 11,
              color: accentSoft,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              title,
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
      const SizedBox(height: 3),
      Padding(
        padding: const EdgeInsets.only(left: 16),
        child: Text(detail, style: const TextStyle(fontSize: 11, color: muted)),
      ),
    ],
  );

  Widget header(bool configured) {
    final active = enabled && configured && routing;
    final detail = !enabled
        ? 'Messages go straight to your proxy. Your item list is kept.'
        : !configured
        ? 'Add your Meta key to start routing. Until then, messages use normal routing.'
        : !routing
        ? 'Messages use normal routing because routing permission is off.'
        : 'Reads each phone message and picks which session should answer.';
    final state = !enabled
        ? 'Off'
        : !configured
        ? 'Needs a key'
        : !routing
        ? 'Routing off'
        : 'On';
    final stateColor = !enabled
        ? muted
        : !configured
        ? warning
        : !routing
        ? muted
        : success;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        pageHeading(
          'Message routing',
          'Decide how phone messages reach your work.',
        ),
        box(
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: accentWash,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Icon(
                      Icons.psychology_outlined,
                      color: accent,
                      size: 22,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: heading(
                      'Brain routing',
                      'The brain reads each phone message first, keeps your item list and picks which session should answer. It never runs commands or approves anything itself.',
                      subtitle: detail,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    state,
                    style: TextStyle(
                      color: stateColor,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Switch(
                    key: const Key('brain-enabled'),
                    value: enabled,
                    onChanged: saving
                        ? null
                        : (v) {
                            setState(() {
                              enabled = v;
                              if (v) {
                                routing = summaries = management = true;
                                providers = {'codex', 'claude'};
                              }
                            });
                            save();
                          },
                  ),
                ],
              ),
              const SizedBox(height: 16),
              const Divider(height: 1),
              const SizedBox(height: 14),
              LayoutBuilder(
                builder: (context, constraints) {
                  final steps = [
                    flowStep('1', 'Your message', 'Sent from your phone'),
                    flowStep(
                      '2',
                      active ? 'Brain routes it' : 'Your coordinator',
                      active
                          ? 'Finds the right session'
                          : 'Receives it directly',
                    ),
                    flowStep(
                      '3',
                      'Reply in your chat',
                      active ? 'From the selected session' : 'Normal routing',
                    ),
                  ];
                  if (constraints.maxWidth < 480) {
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final step in steps)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: step,
                          ),
                      ],
                    );
                  }
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: steps[0]),
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 8),
                        child: Icon(
                          Icons.arrow_forward_rounded,
                          size: 14,
                          color: faint,
                        ),
                      ),
                      Expanded(child: steps[1]),
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 8),
                        child: Icon(
                          Icons.arrow_forward_rounded,
                          size: 14,
                          color: faint,
                        ),
                      ),
                      Expanded(child: steps[2]),
                    ],
                  );
                },
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget modelTab(bool configured) => box(
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        heading(
          'Model and key',
          'The brain sends each phone message to Meta to understand it, using your own key. Usage is billed to your Meta account. A new model applies to your next message.',
        ),
        const SizedBox(height: 8),
        row(
          'Model',
          'Reads each phone message.',
          DropdownButton<String>(
            value: model,
            underline: const SizedBox(),
            items: [
              for (final m
                  in (widget.saved['models'] ?? fallbackMetaBrainModels))
                DropdownMenuItem(value: m as String, child: Text('Meta · $m')),
            ],
            onChanged: saving ? null : (v) => setState(() => model = v!),
          ),
        ),
        row(
          'Meta Model API key',
          configured
              ? 'Saved. Stored only on this computer.'
              : 'Stored only on this computer.',
          configured
              ? Wrap(
                  spacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    OutlinedButton(
                      onPressed: saving
                          ? null
                          : () => setState(() => replacingKey = !replacingKey),
                      child: Text(
                        replacingKey ? 'Keep saved key' : 'Replace key',
                      ),
                    ),
                    TextButton(
                      onPressed: saving ? null : () => save(remove: true),
                      child: const Text('Remove key'),
                    ),
                  ],
                )
              : const SizedBox(),
        ),
        if (!configured || replacingKey) keyField(),
        row(
          "If the brain can't answer",
          failure == 'legacy'
              ? 'Normal routing sends the message to your proxy as if the brain were off.'
              : 'You get a short note on your phone and nothing is sent.',
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'block', label: Text('Stop and tell me')),
              ButtonSegment(value: 'legacy', label: Text('Use normal routing')),
            ],
            selected: {failure},
            showSelectedIcon: false,
            onSelectionChanged: saving
                ? null
                : (v) => setState(() => failure = v.first),
          ),
          tip:
              'Used when Meta is down, the key fails or the answer is unclear.',
        ),
      ],
    ),
  );

  Widget instructionsTab() => box(
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        heading(
          'Instructions',
          'The brain follows these built-in rules for every phone message. What it knows about you lives in your memory files.',
          subtitle: 'The built-in rules every message follows.',
        ),
        const SizedBox(height: 8),
        if (widget.saved['instructions'] is String)
          Theme(
            data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: const Text(
                'Built-in instructions',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
              ),
              subtitle: const Text(
                'Read only. Teach it your words in the memory files instead.',
                style: TextStyle(fontSize: 12, color: muted),
              ),
              children: [
                Container(
                  width: double.infinity,
                  constraints: const BoxConstraints(maxHeight: 320),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: canvas,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      widget.saved['instructions'] as String,
                      style: const TextStyle(
                        fontFamily: 'Menlo',
                        fontSize: 12,
                        height: 1.6,
                        color: muted,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        calloutNote(
          Icons.lock_outline_rounded,
          "Always on, can't be changed.",
          "The brain only follows the message you just sent. It never takes instructions from worker replies or quoted text, never says something was done when it wasn't, and can't change macOS or coding app approvals.",
        ),
      ],
    ),
  );

  Widget memoryTab() => box(
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        toggle(
          'Learn from your messages',
          'When you share something new, it can save it to memory and notify you so you can reply "undo". Session replies, quoted text and files never change it.',
          learn,
          (v) {
            setState(() => learn = v);
            save();
          },
        ),
        const SizedBox(height: 12),
        MemoryFiles(gateway: widget.gateway),
        const SizedBox(height: 12),
        row(
          'Recent conversation',
          'Your last 12 messages and the replies. Helps it understand "that one" or "1".',
          const SizedBox(),
        ),
        row(
          'Item codes and open items',
          'Titles and numbers of your open items, and codes like P1 from the last list you saw.',
          OutlinedButton(
            onPressed: widget.openItems,
            child: const Text('Open Items'),
          ),
        ),
        row(
          'Task history',
          'What the brain understood from each message and what happened next.',
          OutlinedButton(
            onPressed: loadTasks,
            child: const Text('View task history'),
          ),
        ),
        if (taskMessage != null) Text(taskMessage!),
        if (workItems.isNotEmpty) ...[
          const SizedBox(height: 8),
          for (final item in workItems)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('#${item['id']} ${item['title']}'),
              subtitle: Text(
                '${item['status']} • execution: ${item['executionState']} • ${item['session'] ?? 'no session yet'}',
              ),
            ),
        ],
        if (tasks != null) ...[
          if (tasks!.isEmpty) const Text('No tasks yet.'),
          for (final task in tasks!)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text(
                task['original'] as String,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Text(
                '${task['status']} • reply: ${task['responseState'] ?? 'unknown'} • permission: ${task['permission']}',
              ),
              children: [
                ListTile(
                  title: const Text('What you sent'),
                  subtitle: SelectableText(task['original'] as String),
                ),
                ListTile(
                  title: const Text('How the brain read it'),
                  subtitle: SelectableText(
                    task['normalized'] as String? ?? 'Not available',
                  ),
                ),
                ListTile(
                  title: const Text('Saved evidence'),
                  subtitle: SelectableText(
                    'Request: ${task['id']}\nProxy: ${task['coordinator_id'] ?? 'none'}\n${task['reason'] ?? ''}\n${task['evidence']}',
                  ),
                ),
                if (task['nativeOutcome'] == 'done' &&
                    task['verified_at'] == null)
                  TextButton(
                    onPressed: () => verify(task),
                    child: const Text('Verify completed work'),
                  ),
              ],
            ),
        ],
      ],
    ),
  );

  Widget section(
    String title,
    String subtitle,
    IconData icon,
    Widget child, {
    bool open = false,
  }) => Theme(
    data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
    child: ExpansionTile(
      key: Key('brain-section-$title'),
      initiallyExpanded: open,
      tilePadding: const EdgeInsets.symmetric(horizontal: 4),
      childrenPadding: EdgeInsets.zero,
      leading: Icon(icon, color: accent, size: 20),
      title: Text(
        title,
        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        subtitle,
        style: const TextStyle(fontSize: 12, color: muted),
      ),
      children: [child],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final configured = widget.saved['configured'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'YOUR ASSISTANT',
          style: TextStyle(
            fontSize: 10,
            letterSpacing: 1,
            color: muted,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 6),
        const Text(
          'Brain',
          style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 4),
        const Text(
          'Help your messages reach the right session and keep useful context close.',
          style: TextStyle(fontSize: 12, color: muted),
        ),
        const SizedBox(height: 24),
        header(configured),
        if (enabled) ...[
          const SizedBox(height: 12),
          pageHeading(
            'Routing settings',
            'Choose the model and what happens if it can’t answer.',
          ),
          modelTab(configured),
          const SizedBox(height: 12),
          box(
            toggle(
              'Review unclear coding tasks',
              'Propose a short task contract for your approval when a coding request needs clarification.',
              taskContracts,
              (v) {
                setState(() => taskContracts = v);
                save();
              },
            ),
          ),
          section(
            'Instructions',
            'The built-in rules every message follows',
            Icons.notes_rounded,
            instructionsTab(),
          ),
          saveRow('Save changes'),
        ],
        activityTab(),
        const SizedBox(height: 24),
        pageHeading(
          'Memory',
          'Notes sessions can read to understand your preferences.',
        ),
        memoryTab(),
      ],
    );
  }
}

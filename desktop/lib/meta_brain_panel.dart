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
  late bool enabled, routing, summaries, management, learn;
  late String model, failure;
  late Set<String> providers;
  bool saving = false, replacingKey = false;
  String? message, taskMessage;
  List<Map<String, dynamic>>? tasks;
  List<Map<String, dynamic>> workItems = [];
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
  }

  @override
  void dispose() {
    keyInput.clear();
    keyInput.dispose();
    super.dispose();
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

  Widget header(bool configured) {
    final (title, detail) = !enabled
        ? (
            'Brain is off',
            'Your proxy gets every message as it is. Your item list is kept.',
          )
        : configured
        ? (
            'Brain is on',
            'Meta $model. Reads each phone message and picks which session answers.',
          )
        : (
            'Brain needs a key',
            'Until a key is saved, your messages use normal routing.',
          );
    return box(
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
              title,
              'The brain reads each phone message first, keeps your item list and picks which session should answer. It never runs commands or approves anything itself.',
              subtitle: detail,
            ),
          ),
          if (enabled && !configured) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
              decoration: BoxDecoration(
                color: warning.withValues(alpha: .15),
                borderRadius: BorderRadius.circular(999),
              ),
              child: const Text(
                'Needs a key',
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                  color: warning,
                ),
              ),
            ),
            const SizedBox(width: 12),
          ],
          Switch(
            key: const Key('brain-enabled'),
            value: enabled,
            onChanged: saving
                ? null
                : (v) {
                    // The brain's permissions are no longer separate switches: on means it may
                    // route to your connected platforms, keep your items and answer status.
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
          'When you tell it something new, it saves it in the right file and tells you on WhatsApp so you can reply "undo". Session replies, quoted text and files never change it.',
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
        header(configured),
        if (enabled) modelTab(configured),
        if (enabled)
          section(
            'Instructions',
            'The built-in rules every message follows',
            Icons.notes_rounded,
            instructionsTab(),
          ),
        section(
          'Memory',
          'Memory files every session can read',
          Icons.history_rounded,
          memoryTab(),
          open: true,
        ),
        if (enabled) saveRow('Save changes'),
      ],
    );
  }
}

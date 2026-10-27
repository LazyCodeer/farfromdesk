import 'package:flutter/material.dart';

import 'gateway.dart';

/// Native Settings is the only credential input. Status responses never contain a key.
class MetaBrainPanel extends StatefulWidget {
  final Gateway gateway;
  final Map<String, dynamic> saved;
  final Future<void> Function() onSaved;
  const MetaBrainPanel({
    super.key,
    required this.gateway,
    required this.saved,
    required this.onSaved,
  });
  @override
  State<MetaBrainPanel> createState() => _MetaBrainPanelState();
}

class _MetaBrainPanelState extends State<MetaBrainPanel> {
  final keyInput = TextEditingController();
  late bool enabled, routing, summaries, management;
  late String model, failure;
  late Set<String> providers;
  bool saving = false;
  String? message;
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
    model = s['model'] as String? ?? 'muse-spark-1.3';
    failure = s['failure'] as String? ?? 'legacy';
    providers = Set<String>.from(s['providers'] ?? []);
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
        },
        if (!remove && keyInput.text.isNotEmpty) 'key': keyInput.text,
        if (remove) 'removeKey': true,
      });
      if (mounted) {
        keyInput.clear();
      }
      await widget.onSaved();
      if (mounted) {
        setState(() {
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
      }
      if (mounted) {
        setState(() {
          saving = false;
        });
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
        setState(() {
          message = 'Could not load the task ledger.';
        });
      }
    }
  }

  Future<void> verify(Map<String, dynamic> task) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Verify this task is complete?'),
        content: Text(
          'Confirm only after reviewing the work and its evidence. A coordinator report alone is not owner verification.\n\n${task['original']}',
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
        setState(() {
          message = 'Verification could not be saved.';
        });
      }
    }
  }

  Widget label(String text) => Padding(
    padding: const EdgeInsets.only(top: 18, bottom: 4),
    child: Text(
      text,
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w600,
        color: Color(0xffa8a69c),
      ),
    ),
  );

  Widget toggle(
    String title,
    String detail,
    bool value,
    ValueChanged<bool> change,
  ) => SwitchListTile(
    contentPadding: EdgeInsets.zero,
    title: Text(title),
    subtitle: Text(detail),
    value: value,
    onChanged: saving ? null : change,
  );

  @override
  Widget build(BuildContext context) {
    final configured = widget.saved['configured'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        toggle(
          'Use the brain',
          'It reads each phone message, keeps your item list and picks which session should answer.',
          enabled,
          (v) => setState(() => enabled = v),
        ),
        if (enabled) ...[
          label('Model'),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DropdownButton<String>(
                value: model,
                items: [
                  for (final m
                      in (widget.saved['models'] ?? ['muse-spark-1.3']))
                    DropdownMenuItem(
                      value: m as String,
                      child: Text('Meta · $m'),
                    ),
                ],
                onChanged: saving ? null : (v) => setState(() => model = v!),
              ),
              Text(
                configured ? 'Key saved. Stored only on this computer.' : 'No key yet. Until you save one, messages use normal routing.',
              ),
              if (configured)
                TextButton(
                  onPressed: saving ? null : () => save(remove: true),
                  child: const Text('Remove key'),
                ),
            ],
          ),
          TextField(
            controller: keyInput,
            obscureText: true,
            enableSuggestions: false,
            autocorrect: false,
            decoration: InputDecoration(
              labelText: configured
                  ? 'Replace Meta Model API key'
                  : 'Meta Model API key',
              hintText: configured
                  ? 'Leave blank to keep the saved key'
                  : 'Paste your key',
            ),
          ),
          label('What it may do'),
          toggle(
            'Send messages to your proxy and its sessions',
            'Only sessions you already set up. It never starts new ones or changes permissions.',
            routing,
            (v) => setState(() => routing = v),
          ),
          toggle(
            'Keep your item list',
            'Add, number and close items, and pause or resume a session you name.',
            management,
            (v) => setState(() => management = v),
          ),
          toggle(
            'Answer "where are we"',
            'Replies from the saved item list. To get fresh news it asks the session first.',
            summaries,
            (v) => setState(() => summaries = v),
          ),
          label('Sessions it can send to'),
          Wrap(
            spacing: 8,
            children: [
              for (final p in const {
                'codex': 'Codex',
                'claude': 'Claude',
              }.entries)
                FilterChip(
                  label: Text(p.value),
                  selected: providers.contains(p.key),
                  onSelected: saving
                      ? null
                      : (v) => setState(() {
                          if (v) {
                            providers.add(p.key);
                          } else {
                            providers.remove(p.key);
                          }
                        }),
                ),
            ],
          ),
          label("If the brain can't answer"),
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
          const SizedBox(height: 6),
          Text(
            failure == 'legacy'
                ? 'Normal routing sends the message to your proxy as if the brain were off.'
                : 'You get a short note on your phone and nothing is sent.',
            style: const TextStyle(fontSize: 12, color: Color(0xffa8a69c)),
          ),
          const ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('What it sees'),
            subtitle: Text(
              'Sent to Meta with each message. Usage is billed to your Meta account.',
            ),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            childrenPadding: EdgeInsets.only(bottom: 12),
            children: [
              Text(
                'The message you just sent, your open item titles and their numbers, and your last 12 messages and the replies to them. Never your files, keys or session transcripts. macOS and coding app approvals still ask you.',
              ),
            ],
          ),
        ] else
          const Text(
            'Off. Your proxy gets every message as it is. Your item list is kept.',
            style: TextStyle(fontSize: 12, color: Color(0xffa8a69c)),
          ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            FilledButton(
              onPressed: saving ? null : () => save(),
              child: const Text('Save'),
            ),
            const Text(
              "Saving doesn't call Meta.",
              style: TextStyle(fontSize: 12, color: Color(0xffa8a69c)),
            ),
            TextButton(
              onPressed: loadTasks,
              child: const Text('View task history'),
            ),
          ],
        ),
        if (message != null) Text(message!),
        if (workItems.isNotEmpty) ...[
          const Text('Shared to-dos and session ownership'),
          for (final item in workItems)
            ListTile(
              title: Text('#${item['id']} ${item['title']}'),
              subtitle: Text(
                '${item['status']} • execution: ${item['executionState']} • ${item['session'] ?? 'coordinator assignment pending'}',
              ),
            ),
        ],
        if (tasks != null) ...[
          if (tasks!.isEmpty) const Text('No Meta-tracked tasks yet.'),
          for (final task in tasks!)
            ExpansionTile(
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
                  title: const Text('Original owner text'),
                  subtitle: SelectableText(task['original'] as String),
                ),
                ListTile(
                  title: const Text('Normalized wording, advisory only'),
                  subtitle: SelectableText(
                    task['normalized'] as String? ?? 'Not available',
                  ),
                ),
                ListTile(
                  title: const Text('Saved evidence'),
                  subtitle: SelectableText(
                    'Request: ${task['id']}\nCoordinator: ${task['coordinator_id'] ?? 'none'}\n${task['reason'] ?? ''}\n${task['evidence']}',
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
    );
  }
}

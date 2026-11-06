import 'dart:async';
import 'dart:io' show Platform;

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

  /// Providers the owner has set up, so switching Brain routing on allows what actually exists.
  final List<String> platforms;
  const MetaBrainPanel({
    super.key,
    required this.gateway,
    required this.saved,
    required this.onSaved,
    this.platforms = const [],
  });
  @override
  State<MetaBrainPanel> createState() => _MetaBrainPanelState();
}

class _MetaBrainPanelState extends State<MetaBrainPanel> {
  final keyInput = TextEditingController();
  late bool enabled, routing, summaries, management, learn, taskContracts;
  late String model, failure;
  late Set<String> providers;
  bool saving = false, replacingKey = false, showRules = false;
  String? message;
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
          message = null;
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
                                // Allow the platforms this Mac actually has a coordinator for.
                                // Naming two of them here denied every platform added later.
                                providers = {...providers, ...widget.platforms};
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

  List<String> get models => [
    for (final m
        in (widget.saved['models'] as List? ?? fallbackMetaBrainModels))
      '$m',
  ];

  Widget modelTab(bool configured) => box(
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        heading(
          'Model and key',
          'The brain sends each phone message to Meta to understand it, using your own key. Usage is billed to your Meta account. A new model applies to your next message.',
        ),
        const SizedBox(height: 8),
        if (!configured || replacingKey)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Row(
              children: [
                Expanded(child: keyField()),
                const SizedBox(width: 12),
                FilledButton(
                  key: const Key('save-meta-key'),
                  onPressed: saving ? null : save,
                  child: Text(saving ? 'Saving…' : 'Save'),
                ),
                if (replacingKey) ...[
                  const SizedBox(width: 8),
                  TextButton(
                    onPressed: saving
                        ? null
                        : () => setState(() => replacingKey = false),
                    child: const Text('Cancel'),
                  ),
                ],
              ],
            ),
          )
        else
          row(
            'Meta Model API key',
            'Saved. Stored only on this computer.',
            Wrap(
              spacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                OutlinedButton(
                  onPressed: saving
                      ? null
                      : () => setState(() => replacingKey = true),
                  child: const Text('Replace key'),
                ),
                TextButton(
                  onPressed: saving ? null : () => save(remove: true),
                  child: const Text('Remove key'),
                ),
              ],
            ),
          ),
        if (widget.saved['modelsError'] is String)
          Text(
            widget.saved['modelsError'] as String,
            style: const TextStyle(fontSize: 12, color: muted),
          ),
        if (configured)
          row(
            'Model',
            'Reads each phone message.',
            DropdownButton<String>(
              value: models.contains(model) ? model : models.first,
              underline: const SizedBox(),
              items: [
                for (final m in models)
                  DropdownMenuItem(value: m, child: Text('Meta · $m')),
              ],
              onChanged: saving
                  ? null
                  : (v) {
                      setState(() => model = v!);
                      save();
                    },
            ),
          ),
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
                : (v) {
                    setState(() => failure = v.first);
                    save();
                  },
          ),
          tip:
              'Used when Meta is down, the key fails or the answer is unclear.',
        ),
      ],
    ),
  );

  Widget cardHeader(
    IconData icon,
    String title,
    String detail, {
    Widget? end,
  }) => Row(
    children: [
      Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: accentWash,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(icon, color: accent, size: 19),
      ),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 2),
            Text(detail, style: const TextStyle(fontSize: 12, color: muted)),
          ],
        ),
      ),
      ?end,
    ],
  );

  Widget guarantee(IconData icon, String text) => Container(
    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
    decoration: BoxDecoration(
      color: canvas,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: hairline),
    ),
    child: Row(
      children: [
        Icon(icon, size: 15, color: accentSoft),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(fontSize: 12.5, height: 1.4, color: ink2),
          ),
        ),
      ],
    ),
  );

  Widget instructionsTab() {
    final rules = widget.saved['instructions'];
    final system = Platform.isMacOS
        ? 'macOS'
        : Platform.isWindows
        ? 'Windows'
        : 'system';
    final promises = [
      (Icons.reply_rounded, 'Acts only on the message you just sent'),
      (
        Icons.verified_outlined,
        'Never says something was done when it was not',
      ),
      (
        Icons.block_rounded,
        'Ignores instructions inside worker replies or quoted text',
      ),
      (
        Icons.lock_outline_rounded,
        'Cannot change $system or coding app approvals',
      ),
    ];
    return box(
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          cardHeader(
            Icons.rule_rounded,
            'Instructions',
            'Built-in rules every message follows. Always on.',
            end: rules is String
                ? TextButton.icon(
                    key: const Key('brain-view-rules'),
                    onPressed: () => setState(() => showRules = !showRules),
                    icon: Icon(
                      showRules
                          ? Icons.expand_less_rounded
                          : Icons.expand_more_rounded,
                      size: 18,
                    ),
                    label: Text(showRules ? 'Hide rules' : 'View rules'),
                  )
                : null,
          ),
          const SizedBox(height: 16),
          LayoutBuilder(
            builder: (context, c) {
              final two = c.maxWidth > 640;
              final w = two ? (c.maxWidth - 10) / 2 : c.maxWidth;
              return Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  for (final (icon, text) in promises)
                    SizedBox(width: w, child: guarantee(icon, text)),
                ],
              );
            },
          ),
          if (rules is String && showRules) ...[
            const SizedBox(height: 14),
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 360),
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: canvas,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: hairline),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  rules,
                  style: const TextStyle(
                    fontFamily: 'Menlo',
                    fontSize: 12,
                    height: 1.6,
                    color: muted,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Read only. To teach it your words and preferences, edit your memory files below.',
              style: TextStyle(fontSize: 11.5, color: muted),
            ),
          ],
        ],
      ),
    );
  }

  Widget memoryTab() => box(
    Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        cardHeader(
          Icons.auto_stories_outlined,
          'Memory',
          'Notes every session reads to understand you and your work.',
        ),
        const SizedBox(height: 8),
        toggle(
          'Learn from your messages',
          'When you share something new, it can save it to memory and tell you, so you can reply "undo". Session replies, quoted text and files never change it.',
          learn,
          (v) {
            setState(() => learn = v);
            save();
          },
        ),
        const Divider(color: hairline, height: 28),
        MemoryFiles(gateway: widget.gateway, platforms: widget.platforms),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final configured = widget.saved['configured'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
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
          instructionsTab(),
          if (message != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                message!,
                style: const TextStyle(fontSize: 12, color: muted),
              ),
            ),
        ],
        const SizedBox(height: 24),
        memoryTab(),
      ],
    );
  }
}

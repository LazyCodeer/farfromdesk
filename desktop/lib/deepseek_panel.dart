import 'dart:async';

import 'package:flutter/material.dart';

import 'bridge_theme.dart';
import 'gateway.dart';

/// The DeepSeek page.
///
/// A session belongs to a workspace, so the page is a workspace first: the folders that already have
/// a conversation, then the labelled sessions inside the one you picked, each with its own queue and
/// its own undelivered messages. Everything here reads the same route the chat commands write
/// (`/api/deepseek`), so the panel and `/deepseek` cannot disagree.
class DeepSeekPanel extends StatefulWidget {
  final Gateway gateway;
  const DeepSeekPanel({super.key, required this.gateway});

  @override
  State<DeepSeekPanel> createState() => _DeepSeekPanelState();
}

class _DeepSeekPanelState extends State<DeepSeekPanel> {
  final nameInput = TextEditingController();
  final noteInput = TextEditingController();
  Map<String, dynamic>? view;
  String? error;
  String? message;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  @override
  void dispose() {
    nameInput.dispose();
    noteInput.dispose();
    super.dispose();
  }

  Future<void> load() async {
    try {
      final data = await widget.gateway.get('/api/deepseek');
      if (!mounted) return;
      setState(() {
        view = data;
        error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => error = '$e');
    }
  }

  Future<void> act(Map<String, dynamic> body, {String? done}) async {
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final data = await widget.gateway.post('/api/deepseek', body);
      if (!mounted) return;
      setState(() {
        view = data;
        busy = false;
        message = done;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        busy = false;
        message = 'That did not happen. $e';
      });
    }
  }

  String get workspace => '${view?['folder'] ?? ''}';
  String get activeLabel => '${view?['activeLabel'] ?? 'default'}';
  List get sessions => (view?['sessions'] as List?) ?? const [];
  List get folders => (view?['folders'] as List?) ?? const [];
  List get inbox => (view?['inbox'] as List?) ?? const [];

  bool get keyReady {
    final source = '${view?['keySource'] ?? 'none'}';
    return view?['configured'] == true || view?['hasStoredKey'] == true || source != 'none';
  }

  String tail(String path) {
    final parts = path.split(RegExp(r'[\\/]')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return path;
    return parts.length <= 2 ? parts.join('/') : parts.sublist(parts.length - 2).join('/');
  }

  Widget text(String value, {double size = 12.5, Color? color, FontWeight? weight}) => Text(
    value,
    style: TextStyle(fontSize: size, height: 1.45, color: color ?? ink, fontWeight: weight),
  );

  Widget chip(String value, {bool on = false, VoidCallback? onTap}) => Padding(
    padding: const EdgeInsets.only(right: 6, top: 6),
    child: Material(
      color: on ? accent : canvas,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: busy ? null : onTap,
        borderRadius: BorderRadius.circular(999),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: on ? accent : line2),
          ),
          child: Text(
            value,
            style: TextStyle(fontSize: 12, color: on ? Colors.black : ink),
          ),
        ),
      ),
    ),
  );

  Widget smallButton(String label, VoidCallback? onTap, {IconData? icon}) => Padding(
    padding: const EdgeInsets.only(right: 8),
    child: OutlinedButton.icon(
      onPressed: busy ? null : onTap,
      icon: icon == null ? const SizedBox.shrink() : Icon(icon, size: 15),
      label: Text(label, style: const TextStyle(fontSize: 12)),
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        side: const BorderSide(color: line2),
      ),
    ),
  );

  Widget card({required String title, required String subtitle, required Widget body}) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(bottom: 14),
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: line2),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        text(title, size: 14, weight: FontWeight.w600),
        const SizedBox(height: 3),
        text(subtitle, color: muted),
        const SizedBox(height: 14),
        body,
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    if (error != null && view == null) {
      return card(
        title: 'DeepSeek Harness',
        subtitle: 'The app could not read the DeepSeek settings.',
        body: text(error!, color: muted),
      );
    }
    if (view == null) {
      return card(
        title: 'DeepSeek Harness',
        subtitle: 'Reading the sessions…',
        body: text('One moment.', color: muted),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        card(
          title: 'DeepSeek Harness',
          subtitle: keyReady
              ? 'Runs ${view?['route']} with ${view?['model']}. The key comes from the DeepSeek Harness settings.'
              : '${view?['hint'] ?? 'DeepSeek needs a key.'}',
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              text(
                'A session belongs to its workspace. This page shows the workspace you picked and '
                'the sessions inside it; /deepseek in the chat writes exactly these sessions.',
                color: muted,
              ),
              if (message != null) ...[
                const SizedBox(height: 10),
                text(message!, color: muted),
              ],
            ],
          ),
        ),
        card(
          title: 'Workspaces',
          subtitle: folders.length <= 1
              ? 'Only one folder has a DeepSeek session so far.'
              : '${folders.length} folders have a DeepSeek session.',
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                children: [
                  for (final folder in folders)
                    chip(
                      tail('$folder'),
                      on: '$folder' == workspace,
                      onTap: () => act({'action': 'workspace', 'folder': '$folder'}),
                    ),
                ],
              ),
              const SizedBox(height: 10),
              text(workspace, color: muted),
            ],
          ),
        ),
        card(
          title: 'Sessions in this workspace',
          subtitle: 'Active session: $activeLabel. Each one keeps its own conversation and its own queue.',
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (sessions.isEmpty) text('No session yet. Name one below.', color: muted),
              for (final raw in sessions)
                Builder(
                  builder: (context) {
                    final session = Map<String, dynamic>.from(raw as Map);
                    final label = '${session['label']}';
                    final id = session['sessionId'];
                    final running = session['busy'] == true;
                    final waiting = (session['waiting'] as num?)?.toInt() ?? 0;
                    final pending = (session['pending'] as num?)?.toInt() ?? 0;
                    return Container(
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: session['active'] == true ? accentWash : canvas,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: session['active'] == true ? accent : line2),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              text(label, size: 13, weight: FontWeight.w600),
                              const SizedBox(width: 8),
                              text(
                                id == null ? 'no session yet' : 'session ${'$id'.substring(0, id.length < 12 ? id.length : 12)}…',
                                color: muted,
                              ),
                            ],
                          ),
                          const SizedBox(height: 4),
                          text(
                            [
                              if (running) 'running now',
                              if (waiting > 0) '$waiting waiting',
                              if (pending > 0) '$pending undelivered message${pending == 1 ? '' : 's'}',
                              if (!running && waiting == 0 && pending == 0) 'idle',
                            ].join(' · '),
                            color: muted,
                          ),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              if (session['active'] != true)
                                smallButton('Use', () => act({'action': 'use', 'label': label}), icon: Icons.arrow_forward_rounded),
                              if (running)
                                smallButton('Stop', () => act({'action': 'stop', 'label': label}), icon: Icons.stop_rounded),
                            ],
                          ),
                        ],
                      ),
                    );
                  },
                ),
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: nameInput,
                      decoration: const InputDecoration(
                        hintText: 'New session name, for example research',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  smallButton(
                    'New session',
                    () {
                      final name = nameInput.text.trim();
                      if (name.isEmpty) {
                        setState(() => message = 'Name the session first.');
                        return;
                      }
                      nameInput.clear();
                      act({'action': 'new', 'label': name}, done: 'Opened the session "$name". The next /deepseek task runs in it.');
                    },
                    icon: Icons.add_rounded,
                  ),
                ],
              ),
            ],
          ),
        ),
        card(
          title: 'Messages for $activeLabel',
          subtitle: 'A message other sessions leave here is carried into this session\'s next turn. It stays '
              '"prepared" until that turn finishes, so queued is never shown as read.',
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (inbox.isEmpty) text('Nothing queued for $activeLabel.', color: muted),
              for (final raw in inbox.reversed)
                Builder(
                  builder: (context) {
                    final note = Map<String, dynamic>.from(raw as Map);
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          text('${note['state']} · from ${note['from']}', size: 12, color: muted),
                          text('${note['text']}'),
                        ],
                      ),
                    );
                  },
                ),
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: noteInput,
                      decoration: const InputDecoration(
                        hintText: 'Leave a message for this session',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  smallButton(
                    'Leave it',
                    () {
                      final note = noteInput.text.trim();
                      if (note.isEmpty) {
                        setState(() => message = 'Write the message first.');
                        return;
                      }
                      noteInput.clear();
                      act({'action': 'send', 'label': activeLabel, 'text': note},
                          done: 'Left a message for $activeLabel. It is carried into that session\'s next turn.');
                    },
                    icon: Icons.outbox_rounded,
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}
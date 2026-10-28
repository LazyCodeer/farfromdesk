import 'dart:io' show Platform, Process;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import 'bridge_theme.dart';
import 'gateway.dart';
import 'meta_brain_panel.dart' show infoTip;

const _index = 'MEMORY.md', _collaboration = 'collaboration.md', _max = 8000;
const _mono = TextStyle(fontFamily: 'Menlo', fontSize: 11.5, color: muted);
final _item = RegExp(r'^[-*]\s+');

/// The owner's memory folder: one card per file with its saved lines, and the change history.
class MemoryFiles extends StatefulWidget {
  final Gateway gateway;
  const MemoryFiles({super.key, required this.gateway});
  @override
  State<MemoryFiles> createState() => _MemoryFilesState();
}

class _MemoryFilesState extends State<MemoryFiles> {
  final editor = TextEditingController();
  final adders = <String, TextEditingController>{};
  Map<String, dynamic>? data;
  String? message, editPath, platform = 'Codex';
  int? editLine; // null with editPath set means "edit as text"
  bool busy = false;

  List<Map<String, dynamic>> get files => [
    for (final f in data?['files'] as List? ?? [])
      Map<String, dynamic>.from(f as Map),
  ];
  List<Map<String, dynamic>> get history => [
    for (final c in data?['history'] as List? ?? [])
      Map<String, dynamic>.from(c as Map),
  ];

  @override
  void initState() {
    super.initState();
    run(() => widget.gateway.get('/api/memory'));
  }

  @override
  void dispose() {
    editor.dispose();
    for (final c in adders.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> run(
    Future<Map<String, dynamic>> Function() call, {
    String? done,
  }) async {
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final next = await call();
      if (!mounted) return;
      setState(() {
        message = next.remove('notice') as String? ?? done;
        data = next;
        editPath = editLine = null;
      });
    } catch (e) {
      if (mounted) {
        setState(
          () => message = '$e'.replaceFirst(
            RegExp(r'^\w*(Exception|Error): '),
            '',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  String content(String path) =>
      files.firstWhere((f) => f['path'] == path, orElse: () => {})['content']
          as String? ??
      '';

  Future<void> write(
    String path,
    String text,
    String summary, {
    String? expected,
  }) => run(
    () => widget.gateway.post('/api/memory', {
      'path': path,
      'content': text,
      'expected': expected ?? content(path),
      'summary': summary,
    }),
    done: 'Saved. Every session uses it from the next message.',
  );

  /// Line numbers in the file that hold a saved item ("- ...").
  List<int> items(String text) => [
    for (final (i, l) in text.split('\n').indexed)
      if (_item.hasMatch(l)) i,
  ];

  Future<void> setLine(String path, int at, String? next) {
    final lines = content(path).split('\n'),
        old = lines[at].replaceFirst(_item, '');
    if (next == null) {
      lines.removeAt(at);
      return write(path, lines.join('\n'), 'Removed "$old" from $path');
    }
    lines[at] = '- $next';
    return write(path, lines.join('\n'), 'Changed "$old" to "$next" in $path');
  }

  Future<void> addLine(String path, String text) {
    final body = content(path).replaceFirst(RegExp(r'\n*$'), '');
    return write(path, '$body\n- $text\n', 'Added "$text" to $path');
  }

  /// Title from the file's heading, description from its line in MEMORY.md.
  (String, String) about(Map<String, dynamic> f) {
    final path = f['path'] as String, text = f['content'] as String;
    final heading = RegExp(r'^#\s+(.+)$', multiLine: true).firstMatch(text);
    final listed = RegExp(
      r'^[-*]\s+\[([^\]]+)\]\(' + RegExp.escape(path) + r'\)\s*:?\s*(.*)$',
      multiLine: true,
    ).firstMatch(content(_index));
    final title = heading?[1] ?? listed?[1] ?? path.replaceAll('.md', '');
    final hint = listed?[2] ?? '';
    return (
      title,
      hint.isEmpty
          ? (f['always'] == true
                ? 'Read with every message.'
                : 'Opened when a message needs it.')
          : '${hint[0].toUpperCase()}${hint.substring(1)}.',
    );
  }

  Future<void> create() async {
    final name = TextEditingController();
    final path = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('New memory file'),
        content: TextField(
          key: const Key('memory-new-name'),
          controller: name,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'projects/website.md'),
          onSubmitted: (v) => Navigator.pop(context, v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, name.text),
            child: const Text('Create'),
          ),
        ],
      ),
    );
    final clean = path?.trim().toLowerCase() ?? '';
    if (clean.isEmpty) return;
    final file = clean.endsWith('.md') ? clean : '$clean.md';
    final title = file
        .split('/')
        .last
        .replaceAll('.md', '')
        .replaceAll('-', ' ');
    if (files.any((f) => f['path'] == file)) {
      setState(() => message = '$file already exists. Open it to change it.');
      return;
    }
    // Expecting an empty file makes the server refuse if it was created meanwhile.
    await write(
      file,
      '# ${title[0].toUpperCase()}${title.substring(1)}\n',
      'Created $file and listed it in MEMORY.md',
      expected: '',
    );
  }

  Future<void> showIndex() async {
    final text = TextEditingController(text: content(_index));
    final next = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('MEMORY.md'),
        content: SizedBox(
          width: 560,
          child: TextField(
            key: const Key('memory-index-editor'),
            controller: text,
            minLines: 8,
            maxLines: 16,
            style: const TextStyle(fontFamily: 'Menlo', fontSize: 12.5),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, text.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (next != null && next != content(_index)) {
      await write(_index, next, 'Edited the index');
    }
  }

  Future<void> reveal() async {
    final dir = data?['dir'] as String?;
    if (dir == null) return;
    await Process.run(
      Platform.isMacOS
          ? '/usr/bin/open'
          : Platform.isWindows
          ? 'explorer'
          : 'xdg-open',
      [dir],
    );
  }

  String ago(int at) {
    final d = DateTime.now().difference(
      DateTime.fromMillisecondsSinceEpoch(at),
    );
    return d.inMinutes < 1
        ? 'just now'
        : d.inHours < 1
        ? '${d.inMinutes} min ago'
        : d.inDays < 1
        ? '${d.inHours} h ago'
        : '${d.inDays} d ago';
  }

  static const sources = {
    'owner': 'you, in the app',
    'outside': 'outside the app',
    'undo': 'undo',
  };

  Widget platformChip(String value) {
    final brand = switch (value.toLowerCase()) {
      'codex' => 'openai',
      'claude' => 'claude',
      _ => null,
    };
    return Container(
      padding: EdgeInsets.fromLTRB(brand == null ? 12 : 3, 3, 12, 3),
      decoration: ShapeDecoration(
        shape: const StadiumBorder(side: BorderSide(color: line2)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (brand != null) ...[
            Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: brand == 'claude'
                    ? const Color(0xfff4ede4)
                    : const Color(0xfff3f1ea),
                borderRadius: BorderRadius.circular(7),
              ),
              child: Image.asset(
                'assets/logo-$brand.png',
                width: 13,
                height: 13,
              ),
            ),
            const SizedBox(width: 7),
          ],
          Text(
            value,
            style: brand == null
                ? _mono.copyWith(color: ink, fontSize: 12)
                : const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }

  Widget fact(String path, int at, String raw, bool rule) {
    if (editPath == path && editLine == at) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: TextField(
          key: const Key('memory-line-editor'),
          controller: editor,
          autofocus: true,
          style: const TextStyle(fontSize: 13),
          onSubmitted: (v) => v.trim().isEmpty || v.trim() == raw
              ? setState(() => editPath = null)
              : setLine(path, at, v.trim()),
        ),
      );
    }
    final k = raw.indexOf(':');
    final key = k > 0 && k < 28 ? raw.substring(0, k) : '';
    final value = key.isEmpty ? raw : raw.substring(k + 1).trim();
    final narrow = MediaQuery.sizeOf(context).width < 900;
    final body = rule
        ? [
            SizedBox(
              width: narrow ? null : 160,
              child: Text(
                key.isEmpty ? raw : key,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 8),
              child: Icon(
                Icons.arrow_right_alt_rounded,
                size: 20,
                color: muted,
              ),
            ),
            Expanded(
              child: Align(
                alignment: Alignment.centerLeft,
                child: key.isEmpty ? const SizedBox() : platformChip(value),
              ),
            ),
          ]
        : [
            if (key.isNotEmpty)
              SizedBox(
                width: narrow ? 84 : 110,
                child: Text(
                  key,
                  style: const TextStyle(fontSize: 12.5, color: muted),
                ),
              ),
            Expanded(
              child: value.isEmpty
                  ? const Text(
                      'Not set',
                      style: TextStyle(fontSize: 12.5, color: muted),
                    )
                  : Text(value, style: const TextStyle(fontSize: 13)),
            ),
          ];
    return Container(
      constraints: const BoxConstraints(minHeight: 38),
      child: Row(
        children: [
          ...body,
          IconButton(
            tooltip: 'Edit line',
            iconSize: 16,
            visualDensity: VisualDensity.compact,
            color: muted,
            onPressed: busy
                ? null
                : () => setState(() {
                    editPath = path;
                    editLine = at;
                    editor.text = raw;
                  }),
            icon: const Icon(Icons.edit_outlined),
          ),
          IconButton(
            key: Key('memory-remove-$path-$at'),
            tooltip: 'Remove line',
            iconSize: 16,
            visualDensity: VisualDensity.compact,
            color: muted,
            onPressed: busy ? null : () => setLine(path, at, null),
            icon: const Icon(Icons.close_rounded),
          ),
        ],
      ),
    );
  }

  Widget card(Map<String, dynamic> f) {
    final path = f['path'] as String, text = f['content'] as String;
    final always = f['always'] == true, rule = path == _collaboration;
    final (title, hint) = about(f);
    final lines = text.split('\n'), at = items(text);
    final add = adders.putIfAbsent(path, TextEditingController.new);
    final asText = editPath == path && editLine == null;
    void submit() {
      final v = add.text.trim();
      if (v.isEmpty) return;
      add.clear();
      addLine(path, rule ? '$v: $platform' : v);
    }

    return Container(
      key: Key('memory-card-$path'),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      decoration: BoxDecoration(
        color: panelColor,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: rule ? line2 : hairline),
      ),
      child: Column(
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
                      title,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(path, style: _mono),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                decoration: ShapeDecoration(
                  color: always ? accentWash : null,
                  shape: StadiumBorder(
                    side: always
                        ? BorderSide.none
                        : const BorderSide(color: line2),
                  ),
                ),
                child: Text(
                  always ? 'Always read' : 'When needed',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: always ? accent : muted,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(hint, style: const TextStyle(fontSize: 12, color: muted)),
          const SizedBox(height: 6),
          if (asText) ...[
            TextField(
              key: const Key('memory-editor'),
              controller: editor,
              autofocus: true,
              minLines: 6,
              maxLines: 14,
              maxLength: _max,
              style: const TextStyle(
                fontFamily: 'Menlo',
                fontSize: 12.5,
                height: 1.6,
              ),
              decoration: const InputDecoration(counterText: ''),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                FilledButton(
                  key: const Key('memory-save'),
                  onPressed: busy
                      ? null
                      : () => write(path, editor.text, 'Edited $path as text'),
                  child: const Text('Save'),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: () => setState(() => editPath = null),
                  child: const Text('Cancel'),
                ),
              ],
            ),
          ] else ...[
            if (at.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  'Nothing saved yet.',
                  style: TextStyle(fontSize: 12.5, color: muted),
                ),
              ),
            for (final (n, i) in at.indexed) ...[
              if (n > 0) const Divider(height: 1, color: hairline),
              fact(path, i, lines[i].replaceFirst(_item, ''), rule),
            ],
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: Key('memory-add-$path'),
                    controller: add,
                    style: const TextStyle(fontSize: 13),
                    decoration: InputDecoration(
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 11,
                      ),
                      hintText: rule
                          ? 'Kind of work, like Testing'
                          : 'Add a line',
                    ),
                    onSubmitted: (_) => submit(),
                  ),
                ),
                if (rule) ...[
                  const SizedBox(width: 8),
                  DropdownButton<String>(
                    value: platform,
                    underline: const SizedBox(),
                    items: [
                      for (final p in ['Codex', 'Claude'])
                        DropdownMenuItem(value: p, child: Text(p)),
                    ],
                    onChanged: (v) => setState(() => platform = v),
                  ),
                ],
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: busy ? null : submit,
                  child: Text(rule ? 'Add rule' : 'Add'),
                ),
              ],
            ),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              SizedBox(
                width: 70,
                child: LinearProgressIndicator(
                  value: text.length / _max,
                  minHeight: 4,
                  borderRadius: BorderRadius.circular(2),
                  color: accent,
                  backgroundColor: line,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                '${text.length} / 8,000',
                style: const TextStyle(fontSize: 11.5, color: muted),
              ),
              const Spacer(),
              if (!asText)
                TextButton(
                  key: Key('memory-text-$path'),
                  onPressed: () => setState(() {
                    editPath = path;
                    editLine = null;
                    editor.text = text;
                  }),
                  child: const Text('Edit as text'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (data == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Text(
          message ?? 'Loading memory…',
          style: const TextStyle(fontSize: 12, color: muted),
        ),
      );
    }
    final wide = MediaQuery.sizeOf(context).width > 900;
    final shown = files.where((f) => f['path'] != _index).toList();
    final collab = shown.where((f) => f['path'] == _collaboration).toList();
    final rest = shown.where((f) => f['path'] != _collaboration).toList();
    // Two cards per row, with the wide Collaboration card after the first pair.
    final cards = <Widget>[];
    for (var i = 0; i < rest.length; i += wide ? 2 : 1) {
      cards.add(
        wide
            ? Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: card(rest[i])),
                  const SizedBox(width: 12),
                  Expanded(
                    child: i + 1 < rest.length
                        ? card(rest[i + 1])
                        : const SizedBox(),
                  ),
                ],
              )
            : card(rest[i]),
      );
      if (cards.length == (wide ? 1 : 2) && collab.isNotEmpty) {
        cards.add(card(collab.removeAt(0)));
      }
    }
    cards.addAll(collab.map(card));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              'Your memory',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            infoTip(
              'Plain Markdown files in one folder on this computer. The brain, your proxy and every session it sends work to read the always-read files with each message and open the others only when a message needs them. Sessions read them but never change them.',
              label: 'About memory files',
            ),
            const Spacer(),
            OutlinedButton(
              onPressed: busy ? null : create,
              child: const Text('New file'),
            ),
            if (!kIsWeb) ...[
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: reveal,
                child: Text(
                  Platform.isMacOS ? 'Show in Finder' : 'Open folder',
                ),
              ),
            ],
          ],
        ),
        if (message != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              message!,
              style: const TextStyle(fontSize: 12, color: muted),
            ),
          ),
        const SizedBox(height: 10),
        for (final c in cards) ...[c, const SizedBox(height: 12)],
        Row(
          children: [
            const Flexible(
              child: Text(
                'An index file, MEMORY.md, lists these files so sessions know what each one holds. It updates itself when you add a file.',
                style: TextStyle(fontSize: 12, color: muted),
              ),
            ),
            TextButton(onPressed: showIndex, child: const Text('View it')),
          ],
        ),
        const SizedBox(height: 10),
        const Text(
          'Recent changes',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
        if (history.isEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'Nothing saved yet.',
              style: TextStyle(fontSize: 12, color: muted),
            ),
          ),
        for (final c in history.take(8))
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: accent,
                    shape: BoxShape.circle,
                    boxShadow: [BoxShadow(color: accentWash, spreadRadius: 4)],
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        c['summary'] as String,
                        style: const TextStyle(fontSize: 12.5),
                      ),
                      Text(
                        '${(c['source'] as String).startsWith('brain:') ? 'from your message' : sources[c['source']] ?? c['source']}, ${ago(c['at'] as int)}',
                        style: const TextStyle(color: muted, fontSize: 11.5),
                      ),
                    ],
                  ),
                ),
                if (c['source'] != 'undo')
                  OutlinedButton(
                    onPressed: busy
                        ? null
                        : () => run(
                            () => widget.gateway.post('/api/memory/undo', {
                              'id': c['id'],
                            }),
                            done: 'Put back.',
                          ),
                    child: const Text('Undo'),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

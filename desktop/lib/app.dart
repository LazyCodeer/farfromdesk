import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';

import 'gateway.dart';

import 'bridge_theme.dart';
part 'screens.dart';

class FarFromDeskApp extends StatelessWidget {
  final Gateway gateway;
  final Future<void> Function()? initialize;
  const FarFromDeskApp({super.key, required this.gateway, this.initialize});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'FarFromDesk',
    debugShowCheckedModeBanner: false,
    theme: bridgeTheme(),
    home: Desk(gateway: gateway, initialize: initialize),
  );
}

class Desk extends StatefulWidget {
  final Gateway gateway;
  final Future<void> Function()? initialize;
  const Desk({super.key, required this.gateway, this.initialize});
  @override
  State<Desk> createState() => _DeskState();
}

class _DeskState extends State<Desk> {
  Map<String, dynamic> status = {};
  String? error, actionError;
  bool ready = false, busy = false, polling = false, startup = false;
  int section = 0, page = 0;
  String platform = 'codex:cli',
      setupAction = 'new',
      selectedNativeId = '',
      activityFilter = 'All';
  bool automaticName = true, showGroups = false, loadingGroups = false;
  List<Map> groups = [];
  int visibleSessions = 30;
  final customName = TextEditingController();
  StateSetter? modalUpdate;
  final search = TextEditingController();
  final chosen = <String>{};
  final audio = <String, String>{};
  Timer? timer;
  Gateway get api => widget.gateway;
  List<dynamic> get platforms => status['masterSetup']?['platforms'] ?? [];
  Map<String, dynamic> get preferences =>
      Map<String, dynamic>.from(status['preferences'] ?? {});
  @override
  void initState() {
    super.initState();
    section = api.initialScreen;
    boot();
  }

  Future<void> boot() async {
    try {
      await widget.initialize?.call();
      startup = await api.startupEnabled();
      await refresh();
      if (mounted) setState(() => ready = true);
      timer = Timer.periodic(const Duration(seconds: 3), (_) => refresh());
    } catch (e) {
      if (mounted) setState(() => error = clean(e));
    }
  }

  String clean(Object e) => e.toString().replaceFirst('Bad state: ', '');
  @override
  void dispose() {
    timer?.cancel();
    search.dispose();
    customName.dispose();
    super.dispose();
  }

  Future<void> refresh() async {
    if (polling || busy) return;
    polling = true;
    try {
      final next = await api.get('/api/status');
      if (mounted) {
        setState(() {
          status = next;
          if (!ready) showGroups = next['destination']?['kind'] == 'group';
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = clean(e));
    } finally {
      polling = false;
    }
  }

  Future<void> act(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      actionError = null;
    });
    try {
      await action();
      if (mounted) setState(() => error = null);
    } catch (e) {
      if (mounted) setState(() => actionError = clean(e));
    } finally {
      if (mounted) {
        setState(() => busy = false);
        await refresh();
      }
    }
  }

  Future<void> post(String path, [Map<String, dynamic> body = const {}]) =>
      act(() async {
        await api.post(path, body);
      });
  Future<bool> confirm(
    String title,
    String message, {
    String actionLabel = 'Confirm',
  }) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: SelectableText(message),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(actionLabel),
            ),
          ],
        ),
      ) ??
      false;
  Future<String?> ask(String title, {String initial = ''}) async {
    final controller = TextEditingController(text: initial);
    final answer = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: 420,
          child: TextField(
            controller: controller,
            autofocus: true,
            maxLength: 160,
            onSubmitted: (v) => Navigator.pop(context, v),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
    controller.dispose();
    return answer?.trim();
  }

  void changeView(VoidCallback update) => setState(update);
  void go(int index) => setState(() => section = index);
  Widget button(
    String title,
    VoidCallback action, {
    bool enabled = true,
    bool primary = false,
    IconData? icon,
  }) => primary
      ? FilledButton(
          onPressed: busy || !enabled ? null : action,
          child: Text(title),
        )
      : OutlinedButton(
          onPressed: busy || !enabled ? null : action,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 17),
                const SizedBox(width: 8),
              ],
              Text(title),
            ],
          ),
        );
  Widget panel(
    String title,
    Widget child, {
    String? subtitle,
    Widget? trailing,
  }) => Container(
    margin: const EdgeInsets.only(bottom: 18),
    padding: const EdgeInsets.all(24),
    decoration: BoxDecoration(
      color: panelColor,
      borderRadius: BorderRadius.circular(24),
    ),
    child: Material(
      color: Colors.transparent,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              ?trailing,
            ],
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 8),
            Text(subtitle, style: const TextStyle(color: muted)),
          ],
          const SizedBox(height: 18),
          child,
        ],
      ),
    ),
  );
  Widget tag(String text, {bool good = false}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
    decoration: BoxDecoration(
      color: (good ? success : muted).withValues(alpha: .09),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            color: good ? success : muted,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 6),
        Text(
          text,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: good ? success : muted,
          ),
        ),
      ],
    ),
  );
  Widget note(String text) => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Text(text, style: const TextStyle(color: muted, fontSize: 13)),
  );

  @override
  Widget build(BuildContext context) => buildDesk(context);

  List<Widget> setupOperation() {
    final op = status['masterSetup']?['operation'];
    if (op == null || op['status'] == 'ready') return [];
    return [
      const Divider(height: 32),
      Text(
        'Setup: ${op['status']}',
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      if (op['error'] != null) note(op['error']),
      if (['uncertain', 'set-aside'].contains(op['status'])) ...[
        const SizedBox(height: 12),
        Wrap(
          spacing: 10,
          children: [
            button(
              'Recover exact session',
              () => post('/api/master-recover', {'operationId': op['id']}),
            ),
            button('Abandon setup', () async {
              if (await confirm(
                'Abandon this setup?',
                'This closes the setup attempt. It does not delete the native conversation.',
              )) {
                await post('/api/master-abandon', {'operationId': op['id']});
              }
            }),
          ],
        ),
      ],
    ];
  }

  Future<List<Map>?> sessionDialog(
    String title,
    List entries, {
    required bool multiple,
  }) async {
    var query = '', currentPage = 0;
    final selected = <String>{};
    return showDialog<List<Map>>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) {
          final filtered = entries
              .cast<Map>()
              .where(
                (s) => '${s['name']} ${s['cwd']} ${s['id']}'
                    .toLowerCase()
                    .contains(query.toLowerCase()),
              )
              .toList();
          final pages = (filtered.length / 10).ceil().clamp(1, 100000);
          currentPage = currentPage.clamp(0, pages - 1);
          return AlertDialog(
            title: Text(title),
            content: SizedBox(
              width: 720,
              height: 480,
              child: Column(
                children: [
                  TextField(
                    autofocus: true,
                    decoration: const InputDecoration(
                      labelText: 'Search name, project or session ID',
                      prefixIcon: Icon(Icons.search),
                    ),
                    onChanged: (v) => update(() {
                      query = v;
                      currentPage = 0;
                    }),
                  ),
                  const SizedBox(height: 16),
                  Expanded(
                    child: ListView(
                      children: [
                        for (final s
                            in filtered.skip(currentPage * 10).take(10))
                          CheckboxListTile(
                            controlAffinity: ListTileControlAffinity.leading,
                            value: selected.contains(s['id']),
                            onChanged: s['available'] != true
                                ? null
                                : (v) => update(() {
                                    if (!multiple) {
                                      selected.clear();
                                    }
                                    if (v == true) {
                                      selected.add(s['id']);
                                    } else {
                                      selected.remove(s['id']);
                                    }
                                  }),
                            title: Text(
                              s['name'] ?? s['id'],
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            subtitle: Text(
                              '${s['cwd']}\n${s['status'] ?? ''}',
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        if (filtered.isEmpty)
                          const Padding(
                            padding: EdgeInsets.all(24),
                            child: Text(
                              'No matching sessions. Sign in with the native CLI, open a project, then refresh apps.',
                            ),
                          ),
                      ],
                    ),
                  ),
                  Row(
                    children: [
                      Text(
                        '${filtered.length} sessions · page ${currentPage + 1}/$pages',
                      ),
                      const Spacer(),
                      IconButton(
                        tooltip: 'Previous page',
                        onPressed: currentPage > 0
                            ? () => update(() => currentPage--)
                            : null,
                        icon: const Icon(Icons.chevron_left),
                      ),
                      IconButton(
                        tooltip: 'Next page',
                        onPressed: currentPage + 1 < pages
                            ? () => update(() => currentPage++)
                            : null,
                        icon: const Icon(Icons.chevron_right),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: selected.isEmpty
                    ? null
                    : () => Navigator.pop(
                        context,
                        entries
                            .cast<Map>()
                            .where((s) => selected.contains(s['id']))
                            .toList(),
                      ),
                child: Text(
                  multiple
                      ? 'Connect ${selected.length} selected'
                      : 'Choose session',
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> browse() async {
    final entries = <Map>[];
    for (final option in platforms.where((p) => p['executionMode'] == 'cli')) {
      for (final s in option['sessions'] ?? []) {
        entries.add({...s, 'provider': option['provider']});
      }
    }
    final selected = await sessionDialog(
      'Connect worker sessions',
      entries,
      multiple: true,
    );
    if (selected == null || selected.isEmpty) return;
    if (!await confirm(
      'Resume these selected sessions?',
      'Finish active native turns first. These ${selected.length} exact sessions will be added; your other connections remain. Native permissions still apply.',
    )) {
      return;
    }
    await post('/api/desktop/connect-sessions', {
      'targets': selected.map((s) => '${s['provider']}:${s['id']}').toList(),
    });
  }

  Future<void> document(dynamic job) async {
    final path = await api.chooseFile('Review document');
    if (path == null) return;
    if (!await confirm(
      'Send this reviewed document?',
      '$path\n\nRequest: ${job['id']}\n\nConfirm you have reviewed this document for sharing. It will be queued for this request’s selected WhatsApp destination.',
    )) {
      return;
    }
    await act(() async {
      final file = await api.readDocument(path);
      await api.post('/api/desktop/document', {
        'bindingId': job['binding_id'],
        'requestId': job['id'],
        'confirmed': true,
        ...file,
      });
      if (mounted) {
        await showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Document queued'),
            content: SelectableText(
              'Your reviewed document is queued for WhatsApp. Delivery follows the selected request’s destination.',
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
    });
  }
}

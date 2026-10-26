import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:uuid/uuid.dart';

import 'gateway.dart';
import 'updates.dart';

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
      selectedWorkspaceId = '',
      activityFilter = 'All',
      activityQuery = '';
  bool automaticName = true, showGroups = false, loadingGroups = false;
  List<Map> groups = [];
  String? groupsError;
  int visibleSessions = 30;
  final customName = TextEditingController();
  StateSetter? modalUpdate;
  final search = TextEditingController();
  final chosen = <String>{};
  final audio = <String, String>{};
  Timer? timer, updateTimer;
  UpdateCheck update = const UpdateCheck();
  bool checkingUpdates = false;
  bool installingUpdate = false;
  Map<String, dynamic> updateProgress = {};
  Gateway get api => widget.gateway;
  List<dynamic> get platforms => status['masterSetup']?['platforms'] ?? [];
  Map<String, dynamic> get preferences =>
      Map<String, dynamic>.from(status['preferences'] ?? {});
  @override
  void initState() {
    super.initState();
    section = api.initialScreen;
    boot();
    unawaited(checkUpdates());
    updateTimer = Timer.periodic(
      const Duration(hours: 1),
      (_) => checkUpdates(),
    );
  }

  Future<void> boot() async {
    try {
      await widget.initialize?.call();
      startup = await api.startupEnabled();
      await refresh();
      if (mounted) {
        setState(() => ready = true);
        if (showGroups) unawaited(loadGroups());
      }
      timer = Timer.periodic(const Duration(seconds: 3), (_) => refresh());
      await WidgetsBinding.instance.endOfFrame;
      if (mounted && error == null) await api.reportReady();
    } catch (e) {
      if (mounted) setState(() => error = clean(e));
    }
  }

  String clean(Object e) => e.toString().replaceFirst('Bad state: ', '');
  @override
  void dispose() {
    timer?.cancel();
    updateTimer?.cancel();
    api.closeUpdates();
    search.dispose();
    customName.dispose();
    super.dispose();
  }

  Future<void> checkUpdates({bool manual = false}) async {
    if (checkingUpdates) return;
    setState(() => checkingUpdates = true);
    try {
      final result = await api.checkUpdates(manual: manual);
      if (mounted) setState(() => update = result);
    } catch (_) {
      if (mounted) {
        setState(
          () => update = UpdateCheck(
            release: update.release,
            problem: 'Could not check for updates. Try again later.',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => checkingUpdates = false);
    }
  }

  Future<void> showUpdate() async {
    final release = update.release;
    if (release == null) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('A new FarFromDesk is available'),
        content: SizedBox(
          width: 460,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Version ${release.version}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                'Installed: $installedVersion · Download: ${(release.bytes / (1024 * 1024)).ceil()} MB',
              ),
              const SizedBox(height: 18),
              Text(
                api.canInstallUpdate
                    ? 'FarFromDesk will download and verify the update, install it, and restart. Your requests and WhatsApp pairing stay saved.'
                    : 'Download the update and install it after your current work finishes.',
              ),
              const SizedBox(height: 10),
              Text(
                api.canInstallUpdate
                    ? 'If work or a permission request is active, installation will pause before restarting. Your coding apps stay open.'
                    : 'Pause background forwarding and quit FarFromDesk before replacing it.',
              ),
              if (update.problem != null) ...[
                const SizedBox(height: 10),
                Text(update.problem!, style: const TextStyle(color: warning)),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Later'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              act(() => api.openReleasePage(release.notes));
            },
            child: const Text('Release notes'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.pop(context);
              if (api.canInstallUpdate) {
                startUpdate(release);
              } else {
                act(() => api.openReleasePage(release.download));
              }
            },
            child: Text(
              api.canInstallUpdate ? 'Update and restart' : 'Download update',
            ),
          ),
        ],
      ),
    );
  }

  Future<void> startUpdate(AppRelease release) async {
    if (installingUpdate) return;
    setState(() {
      installingUpdate = true;
      updateProgress = {'message': 'Preparing update…'};
    });
    StateSetter? redraw;
    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) => StatefulBuilder(
          builder: (context, setDialogState) {
            redraw = setDialogState;
            final failed = updateProgress['phase'] == 'error';
            final total = (updateProgress['total'] as num?)?.toDouble();
            final received =
                (updateProgress['received'] as num?)?.toDouble() ?? 0;
            return PopScope(
              canPop: !installingUpdate,
              child: AlertDialog(
                title: Text(
                  failed ? 'Update could not finish' : 'Updating FarFromDesk',
                ),
                content: SizedBox(
                  width: 420,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        updateProgress['message']?.toString() ??
                            'Preparing update…',
                      ),
                      if (!failed) ...[
                        const SizedBox(height: 18),
                        LinearProgressIndicator(
                          value: total != null && total > 0
                              ? (received / total).clamp(0.0, 1.0)
                              : null,
                        ),
                        if (total != null) ...[
                          const SizedBox(height: 8),
                          Text(
                            '${(received / 1048576).toStringAsFixed(1)} / ${(total / 1048576).ceil()} MB',
                          ),
                        ],
                      ],
                    ],
                  ),
                ),
                actions: [
                  if (!installingUpdate)
                    TextButton(
                      onPressed: () => Navigator.pop(dialogContext),
                      child: const Text('Close'),
                    ),
                ],
              ),
            );
          },
        ),
      ).whenComplete(() => redraw = null),
    );
    try {
      await api.installUpdate(release, (value) {
        if (!mounted) return;
        setState(() => updateProgress = value);
        redraw?.call(() {});
      });
    } catch (e) {
      if (mounted) {
        setState(
          () => updateProgress = {'phase': 'error', 'message': clean(e)},
        );
      }
    } finally {
      if (mounted) setState(() => installingUpdate = false);
      redraw?.call(() {});
    }
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
        modalUpdate?.call(() {});
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
    final current = status['masterSetup']?['operation'];
    final entries = <Map>[
      if (current is Map) current,
      ...List<Map>.from(status['masterSetup']?['attempts'] ?? []),
    ];
    final seen = <String>{};
    final operations = entries
        .where(
          (op) =>
              !['ready', 'abandoned'].contains(op['status']) &&
              seen.add('${op['id']}'),
        )
        .toList();
    Widget card(Map op) => Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: canvas.withValues(alpha: .6),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: line.withValues(alpha: .5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (op['status'] == 'creating') ...[
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 10),
              ],
              Flexible(
                child: Text(
                  op['status'] == 'creating'
                      ? (op['stage'] ?? 'Preparing your session…')
                      : op['status'] == 'needs_action'
                      ? 'Start your session in Claude'
                      : 'Setup not completed',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
          note(op['name'] ?? 'Coordinator setup'),
          if (op['status'] == 'creating')
            note(
              'You can close this window. Progress will stay visible on Home.',
            ),
          if (op['status'] == 'needs_action')
            note(
              'Open Claude and click Start on the prepared card. FarFromDesk will detect it and connect automatically. You can leave this window open or close it.',
            )
          else if (op['error'] != null)
            note(op['error']),
          if ([
            'uncertain',
            'set-aside',
            'needs_action',
          ].contains(op['status'])) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              children: [
                if (op['status'] == 'needs_action')
                  button(
                    'Open Claude',
                    () => post('/api/master-open-proposal', {
                      'operationId': op['id'],
                    }),
                  ),
                if (op['status'] != 'needs_action')
                  button(
                    'Recover exact session',
                    () =>
                        post('/api/master-recover', {'operationId': op['id']}),
                  ),
                button('Cancel setup', () async {
                  if (await confirm(
                    'Abandon this setup?',
                    'This closes the setup attempt. It does not delete the native conversation.',
                  )) {
                    await post('/api/master-abandon', {
                      'operationId': op['id'],
                    });
                  }
                }),
              ],
            ),
          ],
        ],
      ),
    );
    final previous = operations
        .where((op) => op['id'] != current?['id'])
        .toList();
    return [
      for (final op in operations.where((op) => op['id'] == current?['id']))
        card(op),
      if (previous.isNotEmpty)
        ExpansionTile(
          title: Text(
            'Earlier setup attempts (${previous.length})',
            style: const TextStyle(fontSize: 13, color: muted),
          ),
          shape: const Border(),
          collapsedShape: const Border(),
          tilePadding: EdgeInsets.zero,
          children: [for (final op in previous) card(op)],
        ),
    ];
  }

  Future<List<Map>?> sessionDialog(
    String title,
    List entries, {
    required bool multiple,
  }) async {
    var query = '', currentPage = 0;
    final selected = <String>{};
    String selectionKey(Map s) =>
        '${s['provider']}:${s['executionMode']}:${s['id']}';
    return showDialog<List<Map>>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) {
          final filtered = entries
              .cast<Map>()
              .where(
                (s) =>
                    '${s['provider']} ${s['executionMode']} ${s['name']} ${s['cwd']} ${s['id']}'
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
                            value: selected.contains(selectionKey(s)),
                            onChanged: s['available'] != true
                                ? null
                                : (v) => update(() {
                                    if (!multiple) {
                                      selected.clear();
                                    }
                                    if (v == true) {
                                      selected.add(selectionKey(s));
                                    } else {
                                      selected.remove(selectionKey(s));
                                    }
                                  }),
                            title: Text(
                              s['name'] ?? s['id'],
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            subtitle: Text(
                              '${s['provider']} ${s['executionMode']} · ${s['cwd']}\n${s['status'] ?? ''}',
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        if (filtered.isEmpty)
                          const Padding(
                            padding: EdgeInsets.all(24),
                            child: Text(
                              'No matching sessions. Open the exact chat in its Desktop app or CLI, then refresh apps.',
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
                            .where((s) => selected.contains(selectionKey(s)))
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
    for (final option in platforms) {
      for (final s in option['sessions'] ?? []) {
        if ((s['executionMode'] ?? 'cli') == option['executionMode']) {
          entries.add({
            ...s,
            'provider': option['provider'],
            'executionMode': option['executionMode'],
            'connectionLabel':
                option['connection']?['label'] ?? 'Native session account',
          });
        }
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
      '${selected.map((s) => "${s['name']} · ${s['provider']} ${s['executionMode']}\n${s['connectionLabel']}").join('\n\n')}\n\nThese exact connections will be added or reviewed. Queued work may run using the selected connection. Native permissions still apply.',
    )) {
      return;
    }
    await post('/api/desktop/connect-sessions', {
      'targets': selected
          .map((s) => '${s['provider']}:${s['executionMode']}:${s['id']}')
          .toList(),
      'reviewConnections': true,
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

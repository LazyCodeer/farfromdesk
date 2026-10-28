import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:uuid/uuid.dart';

import 'gateway.dart';
import 'remote_desktop.dart';
import 'meta_brain_panel.dart';
import 'updates.dart';

import 'bridge_theme.dart';
part 'screens.dart';
part 'mac_control_panel.dart';
part 'remote_control_panel.dart';
part 'studio_panes.dart';

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
  // Lets the owner reach the app before linking a chat; not persisted.
  bool onboardingSkipped = false;
  void _macUpdate(VoidCallback change) {
    if (mounted) setState(change);
  }

  int section = 0, page = 0;
  String platform = 'codex:cli',
      setupAction = 'new',
      selectedNativeId = '',
      activityFilter = 'All',
      activityQuery = '',
      itemQuery = '',
      settingsTab = 'Messaging';
  // A stable binding identity, never a request title or session display name.
  String? inboxSelected, inboxError, inboxRequestSelected, inboxCommandSelected;
  String inboxTab = 'Requests';
  List<Map> inboxAttention = [];
  List<Map>? inboxGroups;
  final inboxThreads = <String, Map<String, dynamic>>{};
  final inboxScrolls = <String, ScrollController>{};
  bool inboxLoading = false, inboxOlderLoading = false, inboxShowThread = false;
  int inboxEpoch = 0;
  Timer? inboxSearchTimer;
  final settingsKeys = <String, GlobalKey>{};
  bool editingVoice = false;
  // Item board from the brain; the 3s status poll doesn't carry it.
  List<dynamic> loadedItems = [];
  bool coordinatorNameEdited = false, showGroups = false, loadingGroups = false;
  bool setupFormRequested = false,
      refreshing = false,
      groupsLoaded = false,
      addingCoordinator = false;
  List<Map> groups = [];
  String? groupsError;
  int visibleSessions = 30;
  final telegramToken = TextEditingController();
  final customName = TextEditingController(
    text: 'FarFromDesk Orbit · Codex CLI',
  );
  StateSetter? modalSetter;
  BuildContext? modalContext;
  // In release builds setState on a disposed dialog builder throws a bare
  // "Null check operator" error, so skip a handle whose dialog is gone.
  StateSetter? get modalUpdate =>
      modalContext?.mounted == true ? modalSetter : null;
  final search = TextEditingController();
  final audio = <String, String>{};
  // Voice setup choices; null follows the saved engine.
  String? voicePathChoice, voiceProviderChoice;
  bool replacingVoiceKey = false;
  final voiceKey = TextEditingController();
  Timer? timer, updateTimer;
  DateTime macCheckedAt = DateTime(0);
  bool macChecking = false;
  Map<String, dynamic> remoteLink = {}, phoneRemote = {};
  List<dynamic> phoneApps = [], phoneWindows = [];
  int? phonePid, phoneWindowId;
  String? phoneAddress, remoteError;
  bool remoteBusy = false, changingRemotePassword = false;
  int remoteEpoch = 0;
  bool phoneAddressInitialized = false;
  final remotePassword = TextEditingController(),
      remoteConfirm = TextEditingController();
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
        if (showGroups && status['whatsapp']?['status'] == 'connected') {
          unawaited(loadGroups());
        }
      }
      unawaited(loadItems());
      timer = Timer.periodic(const Duration(seconds: 3), (_) => refresh());
      await WidgetsBinding.instance.endOfFrame;
      if (mounted && error == null) await api.reportReady();
      unawaited(showUpdateOutcome());
    } catch (e) {
      if (mounted) setState(() => error = clean(e));
    }
  }

  Future<void> showUpdateOutcome() async {
    Map<String, dynamic>? result;
    try {
      result = await api.updateOutcome();
    } catch (_) {
      return; // A missing/unreadable receipt must not break normal startup.
    }
    if (!mounted || result == null) return;
    final outcome = result;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          outcome['phase'] == 'complete'
              ? 'Update complete'
              : 'Update needs attention',
        ),
        content: Text(
          outcome['message']?.toString() ??
              'Check the update status before retrying.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  String clean(Object e) => e.toString().replaceFirst('Bad state: ', '');
  @override
  void dispose() {
    timer?.cancel();
    inboxSearchTimer?.cancel();
    for (final controller in inboxScrolls.values) {
      controller.dispose();
    }
    updateTimer?.cancel();
    api.closeUpdates();
    search.dispose();
    customName.dispose();
    telegramToken.dispose();
    remotePassword.dispose();
    remoteConfirm.dispose();
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
                    ? 'FarFromDesk will download and verify the update, install it, and restart. Your requests and messaging connections stay saved.'
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
        if (section == 1) unawaited(loadInbox());
        if (section == 4 &&
            next['macControl']?['supported'] == true &&
            !remoteBusy) {
          unawaited(loadRemote());
        }
        // macOS has no permission-change event, so re-ask while Settings is open.
        if (section == 4 &&
            next['macControl']?['enabled'] == true &&
            DateTime.now().difference(macCheckedAt).inSeconds >= 5) {
          unawaited(checkMac());
        }
        // Groups can only be read once WhatsApp is connected; the first status
        // poll often lands before the socket is up, so load on the first
        // connected poll instead of failing at startup.
        if (ready &&
            showGroups &&
            !groupsLoaded &&
            next['whatsapp']?['status'] == 'connected') {
          unawaited(loadGroups());
        }
      }
    } catch (e) {
      if (mounted) setState(() => error = clean(e));
    } finally {
      polling = false;
    }
  }

  Future<void> checkMac() async {
    if (macChecking) return;
    macCheckedAt = DateTime.now();
    if (mounted) setState(() => macChecking = true);
    try {
      final next = await api.post('/api/mac-control', {'action': 'check'});
      if (mounted) setState(() => status['macControl'] = next);
    } catch (_) {
      // The next poll shows the backend's own error state.
    } finally {
      if (mounted) setState(() => macChecking = false);
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
  void go(int index) {
    setState(() => section = index);
    if (index == 2) unawaited(loadItems());
    if (index == 1) unawaited(loadInbox());
  }

  Widget button(
    String title,
    VoidCallback action, {
    bool enabled = true,
    bool primary = false,
    bool compact = false,
    bool destructive = false,
    bool ignoreBusy = false,
    IconData? icon,
    Key? key,
  }) {
    final size = compact
        ? const ButtonStyle(
            minimumSize: WidgetStatePropertyAll(Size(0, 32)),
            padding: WidgetStatePropertyAll(
              EdgeInsets.symmetric(horizontal: 13),
            ),
            textStyle: WidgetStatePropertyAll(
              TextStyle(
                fontFamily: 'Onest',
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          )
        : null;
    final onPressed = (busy && !ignoreBusy) || !enabled ? null : action;
    final label = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[
          Icon(icon, size: compact ? 15 : 17),
          const SizedBox(width: 8),
        ],
        Text(title),
      ],
    );
    if (primary) {
      return FilledButton(
        key: key,
        onPressed: onPressed,
        style: size,
        child: label,
      );
    }
    return OutlinedButton(
      key: key,
      onPressed: onPressed,
      style: destructive
          ? OutlinedButton.styleFrom(
              backgroundColor: const Color(0x14f87171),
              foregroundColor: danger,
              side: const BorderSide(color: Color(0x59f87171)),
            ).merge(size)
          : size,
      child: label,
    );
  }

  Widget panel(
    String title,
    Widget child, {
    String? subtitle,
    Widget? trailing,
    Color? tone,
    bool light = false,
  }) => card(
    panelBody(title, child, subtitle, trailing, light),
    tone: tone,
    light: light,
  );
  Widget card(
    Widget child, {
    Color? tone,
    bool light = false,
    Key? key,
    EdgeInsets padding = const EdgeInsets.fromLTRB(18, 18, 18, 18),
  }) => Container(
    key: key,
    width: double.infinity,
    margin: const EdgeInsets.only(bottom: 12),
    padding: padding,
    decoration: BoxDecoration(
      color: tone ?? toneCharcoal,
      borderRadius: BorderRadius.circular(14),
      border: Border.all(
        color: tone == null ? line2 : tone.withValues(alpha: .9),
      ),
    ),
    child: Material(
      color: Colors.transparent,
      child: light ? onLightTone(context, child) : child,
    ),
  );
  Widget panelBody(
    String title,
    Widget child,
    String? subtitle,
    Widget? trailing,
    bool light,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: Theme.of(context).textTheme.titleLarge
                  ?.copyWith(color: light ? toneInk : null),
            ),
          ),
          ?trailing,
        ],
      ),
      if (subtitle != null) ...[
        const SizedBox(height: 4),
        Text(
          subtitle,
          style: TextStyle(fontSize: 12.5, color: light ? toneMuted : muted),
        ),
      ],
      const SizedBox(height: 14),
      child,
    ],
  );

  /// Round status chip. [good] is green; otherwise [tint] picks warning,
  /// danger or muted. [spinning] swaps the dot for a small spinner.
  Widget tag(
    String text, {
    bool good = false,
    Color? tint,
    bool spinning = false,
  }) => Builder(
    builder: (c) {
      final light = onLight(c);
      final color =
          tint ?? (good ? (light ? const Color(0xff1f4d3f) : success) : muted);
      final plain = !good && tint == null;
      return Container(
        height: 22,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        decoration: BoxDecoration(
          color: plain
              ? const Color(0xff1a1a1a)
              : color.withValues(alpha: light ? .13 : .12),
          borderRadius: BorderRadius.circular(7),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (spinning) ...[
              SizedBox(width: 11, height: 11, child: spinner(color)),
              const SizedBox(width: 7),
            ] else if (!plain) ...[
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 7),
            ],
            Flexible(
              child: Text(
                text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: plain ? ink2 : color,
                ),
              ),
            ),
          ],
        ),
      );
    },
  );

  /// Small working spinner. Holds still when the system asks for reduced
  /// motion, so the state stays readable without movement.
  Widget spinner(Color color) => Builder(
    builder: (c) => CircularProgressIndicator(
      strokeWidth: 2,
      color: color,
      value: MediaQuery.disableAnimationsOf(c) ? .3 : null,
    ),
  );
  Widget note(String text) => Padding(
    padding: const EdgeInsets.only(top: 10),
    child: Text(text, style: const TextStyle(color: muted, fontSize: 12)),
  );

  /// Brand tile: WhatsApp, Claude or Codex (OpenAI) mark on its own colour.
  Widget logoTile(String brand, {double size = 40, bool dim = false}) {
    if (brand == 'telegram') {
      return Opacity(
        opacity: dim ? .45 : 1,
        child: Image.asset(
          'assets/logo-telegram.png',
          width: size,
          height: size,
          semanticLabel: 'Telegram',
        ),
      );
    }
    final (bg, asset) = switch (brand) {
      'whatsapp' => (whatsappGreen, 'whatsapp'),
      'claude' => (const Color(0xfff4ede4), 'claude'),
      _ => (const Color(0xfff3f1ea), 'openai'),
    };
    final tile = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(size * .3),
      ),
      alignment: Alignment.center,
      child: Image.asset(
        'assets/logo-$asset.png',
        width: size * .53,
        height: size * .53,
      ),
    );
    return dim
        ? Opacity(
            opacity: .45,
            child: ColorFiltered(
              colorFilter: const ColorFilter.matrix([
                .33, .33, .33, 0, 0, //
                .33, .33, .33, 0, 0, //
                .33, .33, .33, 0, 0, //
                0, 0, 0, 1, 0,
              ]),
              child: tile,
            ),
          )
        : tile;
  }

  /// One step of a setup or request timeline: done, now (spinner), wait
  /// (needs the owner), fail, or pending.
  Widget stepRow(String title, {String? detail, String state = 'pending'}) {
    final highlighted = ['now', 'wait', 'fail'].contains(state);
    final marker = switch (state) {
      'done' => Container(
        width: 18,
        height: 18,
        decoration: const BoxDecoration(color: success, shape: BoxShape.circle),
        child: const Icon(Icons.check, size: 12, color: Color(0xff0a0a0a)),
      ),
      'now' => Padding(
        padding: const EdgeInsets.all(2),
        child: SizedBox(width: 14, height: 14, child: spinner(ink)),
      ),
      'wait' || 'fail' => Container(
        width: 18,
        height: 18,
        decoration: BoxDecoration(
          color: state == 'wait' ? warning : danger,
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: (state == 'wait' ? warning : danger).withValues(
                alpha: .18,
              ),
              spreadRadius: 4,
            ),
          ],
        ),
      ),
      _ => Container(
        width: 18,
        height: 18,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: ink.withValues(alpha: .3), width: 1.5),
        ),
      ),
    };
    return Opacity(
      opacity: state == 'pending' ? .6 : 1,
      child: Container(
        margin: const EdgeInsets.only(top: 4),
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        decoration: BoxDecoration(
          color: state == 'fail'
              ? const Color(0x14f87171)
              : highlighted
              ? canvas
              : null,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(padding: const EdgeInsets.only(top: 1), child: marker),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (detail != null)
                    Text(
                      detail,
                      style: const TextStyle(fontSize: 11, color: muted),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Website-style segmented control: dark pill track, mint selected pill.
  Widget segmented(
    List<String> options,
    String value,
    ValueChanged<String> onChanged, {
    Map<String, int>? counts,
    Key? key,
    bool compact = false,
  }) => Container(
    key: key,
    padding: const EdgeInsets.all(3),
    decoration: BoxDecoration(
      color: fieldColor,
      borderRadius: BorderRadius.circular(9),
      border: Border.all(color: line2),
    ),
    child: Wrap(
      spacing: 2,
      children: [
        for (final option in options)
          Material(
            color: option == value
                ? const Color(0xff222222)
                : Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(6),
            ),
            child: InkWell(
              borderRadius: BorderRadius.circular(6),
              onTap: busy ? null : () => onChanged(option),
              child: Padding(
                padding: EdgeInsets.symmetric(
                  horizontal: compact ? 12 : 14,
                  vertical: compact ? 5 : 7,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      option,
                      style: TextStyle(
                        fontSize: compact ? 12.5 : 13,
                        fontWeight: FontWeight.w500,
                        color: option == value ? ink : faint,
                      ),
                    ),
                    if (counts != null) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 7,
                          vertical: 1,
                        ),
                        decoration: BoxDecoration(
                          color: option == value
                              ? const Color(0xff2e2e2e)
                              : canvas,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          '${counts[option] ?? 0}',
                          style: TextStyle(
                            fontSize: 11.5,
                            color: option == value ? ink : faint,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
      ],
    ),
  );

  /// Website-style dropdown: 44px, rounded, inset hairline, chevron.
  Widget dropdown<T>({
    Key? key,
    required T? value,
    required List<DropdownMenuItem<T>> items,
    required ValueChanged<T?>? onChanged,
    String? hint,
    double? width,
  }) => Container(
    width: width,
    height: 40,
    padding: const EdgeInsets.only(left: 12, right: 10),
    decoration: BoxDecoration(
      color: fieldColor,
      borderRadius: BorderRadius.circular(9),
      border: Border.all(color: line2),
    ),
    child: DropdownButtonHideUnderline(
      child: DropdownButton<T>(
        key: key,
        value: value,
        isExpanded: true,
        hint: hint == null
            ? null
            : Text(
                hint,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: ink,
                ),
              ),
        icon: const Icon(Icons.keyboard_arrow_down_rounded, color: faint),
        dropdownColor: raised,
        borderRadius: BorderRadius.circular(10),
        style: const TextStyle(
          fontFamily: 'Onest',
          fontSize: 13,
          fontWeight: FontWeight.w500,
          color: ink,
        ),
        items: items,
        onChanged: busy ? null : onChanged,
      ),
    ),
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
    // Map the backend's setup stages onto three plain steps so progress reads
    // as one honest sequence instead of raw native status text.
    int stepOf(Map op) {
      final stage = '${op['stage'] ?? ''}';
      if (op['status'] == 'needs_action') return 1;
      if (stage.startsWith('Preparing')) return 0;
      if (RegExp(r'Verifying|Connecting').hasMatch(stage)) return 2;
      if (RegExp(r'Claude|startup|Sending|native session').hasMatch(stage)) {
        return 1;
      }
      return op['nativeId'] == null ? 0 : 2;
    }

    String stateOf(Map op, int index) {
      final at = stepOf(op);
      if (index < at) return 'done';
      if (index > at) return 'pending';
      return switch (op['status']) {
        'creating' => 'now',
        'needs_action' => 'wait',
        _ => 'fail',
      };
    }

    Widget card(Map op, {bool detailed = false}) {
      final desktopClaude =
          op['provider'] == 'claude' && op['executionMode'] == 'desktop';
      final waiting = op['status'] == 'needs_action',
          creating = op['status'] == 'creating';
      final at = stepOf(op);
      return Container(
        width: double.infinity,
        margin: const EdgeInsets.only(top: 12),
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
        decoration: BoxDecoration(
          color: toneCharcoal,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: hairline),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        creating
                            ? 'Setting up your coordinator'
                            : waiting
                            ? 'Start your session in Claude'
                            : 'Setup not completed',
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        op['name'] ?? 'Coordinator setup',
                        style: const TextStyle(color: muted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                creating
                    ? tag('Working', spinning: true)
                    : waiting
                    ? tag('Needs you', tint: warning)
                    : tag('Not completed', tint: danger),
              ],
            ),
            if (detailed) ...[
              const SizedBox(height: 8),
              stepRow(
                'Prepare the coordinator folder',
                detail: at == 0 && creating ? op['stage'] : null,
                state: stateOf(op, 0),
              ),
              stepRow(
                desktopClaude
                    ? 'Start the session in Claude'
                    : 'Start the session',
                detail: at == 1 && creating ? op['stage'] : null,
                state: stateOf(op, 1),
              ),
              stepRow(
                'Connect to your chat',
                detail: at == 2 && creating ? op['stage'] : null,
                state: stateOf(op, 2),
              ),
            ],
            if (creating)
              note('You can close this window. Progress stays on Home.'),
            if (waiting)
              note(
                op['workspaceId'] == null
                    ? 'Claude opened a new chat with the setup message filled in. Confirm the folder and press Send. FarFromDesk detects it and connects automatically.'
                    : 'Claude shows a card for this session. Click Start on it once. FarFromDesk detects it and connects automatically.',
              )
            else if (op['error'] != null)
              note(op['error']),
            if ([
              'uncertain',
              'set-aside',
              'needs_action',
            ].contains(op['status'])) ...[
              const SizedBox(height: 14),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (waiting)
                    button(
                      'Open Claude',
                      () => post('/api/master-open-proposal', {
                        'operationId': op['id'],
                      }),
                      primary: true,
                    ),
                  if (!waiting)
                    button(
                      'Recover exact session',
                      () => post('/api/master-recover', {
                        'operationId': op['id'],
                      }),
                      primary: true,
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
                  if (waiting)
                    const Text(
                      'Checking every few seconds',
                      style: TextStyle(fontSize: 11, color: muted),
                    ),
                ],
              ),
            ],
          ],
        ),
      );
    }

    final previous = operations
        .where((op) => op['id'] != current?['id'])
        .toList();
    return [
      for (final op in operations.where((op) => op['id'] == current?['id']))
        card(op, detailed: true),
      if (previous.isNotEmpty)
        ExpansionTile(
          title: Text(
            'Earlier setup attempts (${previous.length})',
            style: const TextStyle(fontSize: 12.5, color: muted),
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
      '$path\n\nRequest: ${job['id']}\n\nConfirm you have reviewed this document for sharing. It will be queued for this request’s original chat.',
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
              'Your reviewed document is queued for your chat. Delivery follows the selected request’s destination.',
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

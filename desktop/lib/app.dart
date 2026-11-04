import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:uuid/uuid.dart';

import 'gateway.dart';
import 'native_gateway.dart';
import 'local_email_screen.dart';
import 'remote_desktop.dart';
import 'meta_brain_panel.dart';
import 'deepseek_panel.dart';
import 'updates.dart';
import 'connection_status.dart';
import 'ffd_select.dart';
import 'startup_trace.dart';
import 'social_preview.dart';
import 'server_mode_activity.dart';
import 'social_screen.dart';
import 'chat_message_text.dart';

import 'bridge_theme.dart';
part 'screens.dart';
part 'mac_control_panel.dart';
part 'remote_control_panel.dart';
part 'studio_panes.dart';
part 'overview_metric_art.dart';

class DesktopCloseGuard {
  Future<bool> Function()? _check;
  void Function()? _release;
  void attach(Future<bool> Function() check, void Function() release) {
    _check = check;
    _release = release;
  }

  void detach(Future<bool> Function() check) {
    if (_check == check) {
      _check = null;
      _release = null;
    }
  }

  Future<bool> allowClose() async => await _check?.call() ?? true;
  void release() => _release?.call();
}

class FarFromDeskApp extends StatelessWidget {
  final Gateway gateway;
  final Future<void> Function()? initialize;
  final DesktopCloseGuard? closeGuard;
  const FarFromDeskApp({
    super.key,
    required this.gateway,
    this.initialize,
    this.closeGuard,
  });
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'FarFromDesk',
    debugShowCheckedModeBanner: false,
    theme: bridgeTheme(),
    home: Desk(
      gateway: gateway,
      initialize: initialize,
      closeGuard: closeGuard,
    ),
  );
}

class Desk extends StatefulWidget {
  final Gateway gateway;
  final Future<void> Function()? initialize;
  final DesktopCloseGuard? closeGuard;
  const Desk({
    super.key,
    required this.gateway,
    this.initialize,
    this.closeGuard,
  });
  @override
  State<Desk> createState() => _DeskState();
}

class _DeskState extends State<Desk> {
  Map<String, dynamic> status = {};
  String? error, actionError;
  bool ready = false, busy = false, polling = false, startup = false;
  bool coordinatorSubmitting = false;
  // Which step of the add-a-coordinator flow is showing.
  int setupStep = 1;
  // Muse runs headless and cannot ask to trust a folder, so this is chosen up front.
  bool workspaceTrust = true;
  // Lets the owner reach the app before linking a chat; not persisted.
  bool onboardingSkipped = false;
  // An explicit request from the offline banner to reopen setup.
  bool setupRequested = false;
  int section = 0, page = 0;
  String platform = 'codex:cli',
      setupAction = 'new',
          // The project a new coordinator runs in; empty means its own private folder.
          selectedWorkspaceId =
          '',
      selectedNativeId = '',
      itemQuery = '',
          // Stable Settings tab id, not a display title: the title carries the
          // machine name and would drift.
          settingsTab =
          'this-mac';
  // The Inbox is one conversation per view, all of it read from
  // /api/inbox-feed. Nothing here is derived from the status poll.
  String? inboxError, inboxRequestSelected;
  String inboxViewId = 'all', inboxQuery = '';
  List<Map> inboxViews = [], inboxFilters = [];
  Map<String, dynamic> inboxView = {}, inboxStats = {};
  List<Map> inboxMessages = [];
  Map<String, dynamic>? inboxNext;
  ScrollController? inboxScroll;
  final inboxReply = TextEditingController();
  // Which messages have their details panel open. Collapsed by default.
  final inboxExpanded = <String>{};
  bool inboxLoading = false,
      inboxOlderLoading = false,
      inboxShowConversation = false,
      // True once a feed request finished, so a failure is reported once instead
      // of the pane re-asking for a conversation it cannot load.
      inboxAttempted = false,
      // True once an earlier page was pulled in. Until then the newest page IS
      // the whole history, so a refresh replaces it and a reviewed entry that
      // the feed no longer returns really disappears.
      inboxLoadedOlder = false,
      inboxSending = false;
  // The epoch of the page request that is in flight, so the poll cannot stack a
  // second request while a view switch is still allowed to replace it.
  int inboxEpoch = 0, inboxLoadingEpoch = -1;
  Timer? inboxSearchTimer;
  final socialKey = GlobalKey<SocialScreenState>();
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
  Timer? timer, updateTimer, bootRetryTimer;
  /// Started, not stuck. A busy launch can outrun the gateway's own health wait,
  /// and the app used to show a permanent "the local backend did not start"
  /// banner for that, because the status poll was only armed after a successful
  /// boot. The first attempts now keep the spinner, and the poll runs either way,
  /// so a slow start resolves itself instead of needing a tab switch to clear it.
  int bootAttempts = 0;
  bool booting = false;
  /// Set when a start was refused because an older copy of this app is still
  /// holding the backend port, so the banner can offer to end it in one press
  /// instead of asking the owner to go find the process.
  int? stuckHolderPid;
  static const _bootRetryDelay = Duration(seconds: 3);
  static const _bootGraceAttempts = 5;
  static const _bootMaxAttempts = 40;

  /// How long a manual "Check now" keeps its spinner up even when the check
  /// answers instantly, so pressing the button visibly does something.
  static const _updateCheckFloor = Duration(milliseconds: 700);
  /// The cadence the Updates pane displays and the checker enforces. One value,
  /// two readers, so the sentence under the dropdown cannot drift from what
  /// actually runs - which is exactly what had happened.
  UpdateSchedule updateSchedule = UpdateSchedule.hourly;
  /// Stored alongside the schedule so the preference file keeps its shape; the
  /// App updates switch that would read it is not built yet, so nothing here
  /// can silently start installing on its own.
  bool autoUpdate = true;
  DateTime macCheckedAt = DateTime(0);
  bool macChecking = false;
  /// Set while the desktop driver is being tested, so the two driver rows show one
  /// spinner and a second press cannot stack.
  bool driverChecking = false;
  Map<String, dynamic> remoteLink = {}, phoneRemote = {}, legacyRemote = {};
  List<dynamic> phoneApps = [], phoneWindows = [];
  int? phonePid, phoneWindowId;
  String? phoneAddress, remoteError;
  bool remoteBusy = false, changingRemotePassword = false;
  bool remotePasswordVisible = false, remoteConfirmVisible = false;
  int remoteEpoch = 0;
  bool phoneAddressInitialized = false;
  final remotePassword = TextEditingController(),
      remoteConfirm = TextEditingController();
  UpdateCheck update = const UpdateCheck();
  bool checkingUpdates = false;
  bool installingUpdate = false;
  Map<String, dynamic> updateProgress = {};
  Gateway get api => widget.gateway;

  /// Muse Code, DeepSeek Harness and Cursor are channel mode, so a desktop entry for them never
  /// reaches the UI. Cursor is app-driven but still runs one turn per request, not a desktop session.
  List<dynamic> get platforms => [
    for (final p in status['masterSetup']?['platforms'] ?? const [])
      if (!const ['muse', 'deepseek', 'cursor'].contains(p['provider']) ||
          p['executionMode'] != 'desktop')
        p,
  ];
  Map<String, dynamic> get preferences =>
      Map<String, dynamic>.from(status['preferences'] ?? {});
  @override
  void initState() {
    super.initState();
    section = api.initialScreen;
    widget.closeGuard?.attach(allowClose, releaseCloseLock);
    boot();
    unawaited(checkUpdates());
    armUpdateTimer();
  }

  /// Wakes on the cadence the pane shows. The checker enforces the same interval
  /// too, so an early wake is a no-op rather than an extra network call.
  void armUpdateTimer() {
    updateTimer?.cancel();
    updateTimer = Timer.periodic(updateSchedule.interval, (_) => checkUpdates());
  }

  Future<void> boot() async {
    // "Try again" already proved this is safe to call repeatedly; the guard only
    // stops two starts from overlapping while one is still waiting on health.
    if (booting) {
      scheduleBootRetry();
      return;
    }
    booting = true;
    try {
      await widget.initialize?.call();
      traceStartup('reading login registration');
      startup = await api.startupEnabled();
      traceStartup('reading update preferences');
      final updatePrefs = await api.loadUpdatePreferences();
      if (mounted) {
        setState(() {
          updateSchedule = updatePrefs.schedule;
          autoUpdate = updatePrefs.automatic;
        });
        // Re-armed with whatever was actually stored, so the first automatic
        // check after launch already uses the owner's cadence.
        armUpdateTimer();
      }
      traceStartup('reading initial status');
      await refresh();
      if (mounted) {
        setState(() => ready = true);
        if (showGroups && status['whatsapp']?['status'] == 'connected') {
          unawaited(loadGroups());
        }
      }
      unawaited(loadItems());
      bootAttempts = 0;
      armStatusTimer();
      await WidgetsBinding.instance.endOfFrame;
      if (mounted && error == null) {
        await api.reportReady();
        traceStartup('UI ready');
      }
      unawaited(showUpdateOutcome());
    } catch (e) {
      traceStartup('startup failed');
      bootAttempts++;
      if (!mounted) return;
      // A backend that is merely slow is a state to recover from, so it keeps the
      // spinner, retries by itself, and starts the status poll. A Local state
      // problem is named at once, because the message says which file or path is
      // wrong and the owner can act on it, but it still retries: those causes are
      // often a leftover temporary file that a running session removes by itself.
      // Any other failure (a refused window call, a broken install) is reported at
      // once, exactly as before: retrying those would only hide a real error.
      final retryable = e is BackendNotReady || e is LocalStateUnsafe;
      final stuck = e is BackendNotReady && e.holderIsOurs ? e.holderPid : null;
      // A blocker we can name is information, so it is shown at once with the way
      // out. Only an unnamed slow launch keeps the spinner, because there is
      // nothing to report yet and a busy start usually clears itself.
      final silentGrace =
          retryable && e is! LocalStateUnsafe && stuck == null && !showStartupError;
      setState(() {
        stuckHolderPid = stuck;
        error = silentGrace ? null : clean(e);
      });
      if (retryable) {
        armStatusTimer();
        scheduleBootRetry();
      }
    } finally {
      booting = false;
    }
  }

  /// Ends the older copy that is still holding the app port, then starts again.
  /// The gateway refuses unless the process is confirmed to be our own backend,
  /// so a shared port never turns this press into killing someone else's work.
  Future<void> stopStuckCopy() async {
    final pid = stuckHolderPid;
    if (pid == null) return;
    setState(() {
      stuckHolderPid = null;
      error = null;
    });
    await api.stopStuckBackend(pid);
    // The pending retry belongs to the copy that was just ended.
    bootRetryTimer?.cancel();
    bootAttempts = 0;
    await boot();
  }

  /// A slow launch and a broken install look identical for the first seconds, so
  /// neither the start nor a failed status poll claims failure until the retries
  /// have had their chance. One rule, read by both.
  bool get showStartupError => bootAttempts >= _bootGraceAttempts;
  /// True while a retryable start is still being retried, so a status poll that
  /// lands in that window does not put a startup error over the spinner.
  bool get startupRetrying => bootRetryTimer?.isActive == true;

  /// Bounded, so a genuinely broken install does not spin forever, but long
  /// enough that a busy launch recovers without the owner touching anything.
  void scheduleBootRetry() {
    if (bootAttempts >= _bootMaxAttempts) return;
    bootRetryTimer?.cancel();
    bootRetryTimer = Timer(_bootRetryDelay, () {
      if (mounted && !ready) unawaited(boot());
    });
  }

  /// Startup must never be the only thing that can arm the poll: it is what turns
  /// a slow or refused launch into a working app instead of an unclearable banner.
  void armStatusTimer() {
    if (timer != null) return;
    timer = Timer.periodic(const Duration(seconds: 3), (_) => refresh());
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
    widget.closeGuard?.detach(allowClose);
    timer?.cancel();
    inboxSearchTimer?.cancel();
    inboxScroll?.dispose();
    inboxReply.dispose();
    updateTimer?.cancel();
    unawaited(ServerModeActivity.setActive(false));
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
    final started = DateTime.now();
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
      // A check against a local or already-cached feed returns in a couple of
      // milliseconds, so the spinner never got a frame and the button read as
      // dead. Hold the busy state briefly so the press is acknowledged.
      final elapsed = DateTime.now().difference(started);
      if (manual && elapsed < _updateCheckFloor) {
        await Future<void>.delayed(_updateCheckFloor - elapsed);
      }
      if (mounted) setState(() => checkingUpdates = false);
    }
  }

  /// Changes how often the app checks, and persists it.
  ///
  /// This is the whole of the schedule feature: the value the pane renders its
  /// sentence from is the same value the checker throttles on, so the app can no
  /// longer claim a cadence it is not keeping.
  Future<void> setUpdateSchedule(UpdateSchedule next) async {
    setState(() => updateSchedule = next);
    armUpdateTimer();
    try {
      await api.saveUpdatePreferences(
        UpdatePreferences(schedule: next, automatic: autoUpdate),
      );
    } catch (_) {
      // The choice still applies for this run; a failed write must not undo the
      // option the owner just picked.
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
      // A status that arrives without a completed startup still means the backend
      // is there, so finish starting rather than leaving a spinner or a banner no
      // later event would clear. This is what a tab switch used to do by hand.
      final recovering = !ready && !booting;
      if (mounted) {
        setState(() {
          status = next;
          if (recovering) ready = true;
          if (!setupActive &&
              !platforms.any(
                (p) =>
                    '${p['provider']}:${p['executionMode']}' == platform &&
                    p['available'] == true,
              )) {
            final detected = platforms.where((p) => p['available'] == true);
            if (detected.isNotEmpty) {
              final first = detected.first;
              selectCoordinatorPlatform(
                '${first['provider']}:${first['executionMode']}',
              );
              selectedNativeId = '';
            }
          }
          if (!ready) showGroups = next['destination']?['kind'] == 'group';
          error = null;
        });
        if (recovering) {
          unawaited(loadItems());
          unawaited(api.reportReady());
        }
        // A hidden or lid-closed app can be App Napped; opt out only while
        // server mode is actually keeping sleep off.
        final serverMode = Map<String, dynamic>.from(
          next['preferences']?['serverMode'] ?? const {},
        );
        unawaited(ServerModeActivity.setActive(serverMode['active'] == true));
        modalUpdate?.call(() {});
        if (section == 1) unawaited(loadInboxFeed());
        if (section == 6) unawaited(socialKey.currentState?.refreshQuietly());
        if (section == 4 &&
            next['macControl']?['supported'] == true &&
            !remoteBusy) {
          unawaited(loadRemote());
        }
        // macOS has no permission-change event, so refresh on Overview and Settings.
        if ((section == 0 || section == 4) &&
            next['macControl']?['supported'] == true &&
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
      if (mounted) {
        // While the app has never started, the error is the whole state and must be
        // shown. Once it is running, one slow or refused poll keeps the last good
        // status instead of putting a startup error over a working screen; the
        // retry two seconds later clears it anyway.
        // Silent while a retryable start is still being retried, including during
        // the retry's own status read: that window is exactly the slow launch this
        // is meant to ride out. Once the retries stop, a failure is reported.
        if (!ready && !booting && !startupRetrying) {
          setState(() => error = clean(e));
        }
        modalUpdate?.call(() {});
      }
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
      if (mounted) {
        // Merge, never replace: a check response that omits `supported` used to
        // wipe the flag and hide the whole Permissions section until the next
        // status poll put it back.
        final previous = Map<String, dynamic>.from(status['macControl'] ?? {});
        final capture = Map<String, dynamic>.from(previous['capture'] ?? {});
        final nextCapture = Map<String, dynamic>.from(next['capture'] ?? {});
        setState(
          () => status['macControl'] = {
            ...previous,
            ...next,
            'capture': {...capture, ...nextCapture},
          },
        );
      }
    } catch (_) {
      // The next poll shows the backend's own error state.
    } finally {
      if (mounted) setState(() => macChecking = false);
    }
  }

  /// Try the desktop driver and report what happened.
  ///
  /// The driver's own permission preflight is not trustworthy in embedded mode: it
  /// was measured saying `accessibility: false` while a read through the same driver
  /// returned a window's accessibility tree. So the driver rows in Settings are
  /// decided by this test, which asks the backend to make one harmless read.
  Future<void> probeDriverAccess() async {
    if (driverChecking) return;
    if (mounted) setState(() => driverChecking = true);
    try {
      final next = await api.post('/api/desktop-control-permission', {
        'action': 'probe',
      });
      if (mounted) {
        // Merge, never replace: the response carries the permission and the test,
        // and a partial answer must not wipe what the status poll already knew.
        final previous = Map<String, dynamic>.from(
          status['desktopControl'] ?? {},
        );
        setState(
          () => status['desktopControl'] = {
            ...previous,
            ...next,
            'permission': next['permission'] ?? previous['permission'],
            'capability': next['capability'] ?? previous['capability'],
          },
        );
      }
    } catch (_) {
      // The next poll shows the backend's own error state.
    } finally {
      if (mounted) setState(() => driverChecking = false);
    }
  }

  Future<void> act(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      actionError = null;
    });
    modalUpdate?.call(() {});
    try {
      await action();
      if (mounted) setState(() => error = null);
    } catch (e) {
      if (mounted) {
        setState(() => actionError = clean(e));
        modalUpdate?.call(() {});
      }
    } finally {
      if (mounted) {
        setState(() => busy = false);
        await refresh();
        if (mounted) modalUpdate?.call(() {});
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

  void changeView(VoidCallback update) {
    setState(update);
    modalUpdate?.call(() {});
  }

  Future<bool> allowClose() async {
    if (section != 6 || socialKey.currentState == null) return true;
    return socialKey.currentState!.allowLeave(forClose: true);
  }

  void releaseCloseLock() => socialKey.currentState?.releaseCloseLock();

  void go(int index) {
    unawaited(navigate(index));
  }

  Future<bool> navigate(int index) async {
    if (section == 6 &&
        index != 6 &&
        socialKey.currentState != null &&
        !await socialKey.currentState!.allowLeave()) {
      return false;
    }
    if (!mounted) return false;
    setState(() => section = index);
    if (index == 2) unawaited(loadItems());
    if (index == 1) unawaited(loadInboxFeed());
    return true;
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
              TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
            ),
          )
        : null;
    final onPressed = (busy && !ignoreBusy) || !enabled ? null : action;
    final label = icon == null
        ? Text(title, textAlign: TextAlign.center)
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: compact ? 15 : 17),
              const SizedBox(width: 8),
              Flexible(child: Text(title, textAlign: TextAlign.center)),
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

  /// Brand tile: WhatsApp, Claude, Codex (OpenAI) or Muse Code on its colour.
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
    // Muse Code ships a dark-mode mark (blue chevron, white M), so its tile is dark and the mark
    // is the real one from the CLI rather than a stand-in glyph. DeepSeek Harness ships a blue
    // whale drawn for a light tile. Cursor ships a dark geometric mark, so its tile is dark too.
    final (bg, asset) = switch (brand) {
      'whatsapp' => (whatsappGreen, 'whatsapp'),
      'claude' => (const Color(0xfff4ede4), 'claude'),
      'muse' => (const Color(0xff1b1b20), 'muse'),
      'deepseek' => (const Color(0xffffffff), 'deepseek'),
      'cursor' => (const Color(0xff1b1b20), 'cursor'),
      _ => (const Color(0xfff3f1ea), 'openai'),
    };
    final mark = brand == 'muse' || brand == 'cursor'
        ? .62
        : (brand == 'deepseek' ? .74 : .53);
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
        width: size * mark,
        height: size * mark,
        fit: BoxFit.contain,
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
      // Muse Code is CLI only, so a waiting CLI setup must not read as an app.
      final desktopApp = op['executionMode'] == 'desktop';
      final label = providerLabel(op['provider']);
      final waiting = op['status'] == 'needs_action',
          creating = op['status'] == 'creating';
      final heading = creating
          ? 'Setting up your coordinator'
          : waiting
          ? desktopClaude
                ? 'Start your session in Claude'
                : desktopApp
                ? 'Start the session in $label'
                : 'Setup needs you'
          : 'Setup not completed';
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
                        heading,
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
                !desktopApp
                    ? '$label is running in its terminal. FarFromDesk connects the session automatically when it is ready.'
                    : op['workspaceId'] == null
                    ? '$label opened a new chat with the setup message filled in. Confirm the folder and press Send. FarFromDesk detects it and connects automatically.'
                    : '$label shows a card for this session. Click Start on it once. FarFromDesk detects it and connects automatically.',
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
                  if (waiting && desktopApp)
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
                              '${providerLabel(s['provider'])} ${s['executionMode'] == 'desktop' ? 'Desktop' : 'CLI'} · ${s['cwd']}\n${s['status'] ?? ''}',
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
      '${selected.map((s) => "${s['name']} · ${providerLabel(s['provider'])} ${s['executionMode'] == 'desktop' ? 'Desktop' : 'CLI'}\n${s['connectionLabel']}").join('\n\n')}\n\nThese exact connections will be added or reviewed. Queued work may run using the selected connection. Native permissions still apply.',
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

import 'dart:async';

/// The backend is not answering yet. Retryable, and never a reason to claim the
/// installation is broken until the retries have had their chance.
class BackendNotReady implements Exception {
  BackendNotReady(this.message, {this.holderPid, this.holderIsOurs = false});
  final String message;

  /// The process sitting on our port or our data folder, when it could be
  /// identified. It is named in the message so the owner can quit it, and
  /// offered as one press when the process is our own app.
  final int? holderPid;
  final bool holderIsOurs;
  @override
  String toString() => message;
}

/// A process found holding the app's port or its data folder.
class PortHolder {
  const PortHolder(this.pid, {required this.isOurs, this.onPort = true});
  final int pid;

  /// True when the process is this app's own backend, which is the only case the
  /// UI may offer to end.
  final bool isOurs;

  /// False when the process was found through the data-folder lock rather than
  /// the port, which is how a copy that never finished starting shows up.
  final bool onPort;
}

/// What the port looked like before a launch.
enum PortState {
  /// Nothing holds the port or the data folder; it is safe to start a backend.
  free,

  /// Something was there and answered, so it was adopted instead of raced.
  adopted,
}

Future<void> _sleep(Duration d) => Future<void>.delayed(d);

/// Decides what to do about the app port before starting a backend.
///
/// A second copy of the app used to launch a second backend into the same data
/// folder. That one dies on the folder lock, and the owner is left with a banner
/// that blames the installation while the real cause, an older copy still
/// holding the folder, stays invisible. So nothing is launched while something is
/// already there: whoever holds the port or the data folder is given time to
/// answer, is adopted when it does, and when it never answers the owner is told
/// exactly which process is in the way.
///
/// The data-folder check matters as much as the port. A copy that wedges before
/// it binds its port holds the folder lock and answers nothing, so the port looks
/// free and a freshly launched backend dies on the lock for no visible reason.
Future<PortState> awaitPortOrAdopt({
  required Future<bool> Function() healthy,
  required Future<bool> Function() listening,
  required Future<PortHolder?> Function() holder,
  Future<PortHolder?> Function()? lockHolder,
  required String port,
  Duration budget = const Duration(seconds: 45),
  Duration lockBudget = const Duration(seconds: 20),
  Duration poll = const Duration(milliseconds: 500),
  Future<void> Function(Duration) sleep = _sleep,
  DateTime Function() now = DateTime.now,
}) async {
  if (await listening()) {
    return _waitOrThrow(
      healthy: healthy,
      listening: listening,
      named: holder,
      port: port,
      budget: budget,
      poll: poll,
      sleep: sleep,
      now: now,
    );
  }
  // A backend that is still shutting down can free the port between these two
  // checks, so the port is only called free once health agrees.
  if (await healthy()) return PortState.adopted;
  final blocked = lockHolder;
  if (blocked == null || await blocked() == null) return PortState.free;
  // A backend that holds the data folder is either seconds away from binding or
  // never going to: it does not get the full port budget, because waiting there
  // only makes the owner watch a spinner while the answer is already known.
  return _waitOrThrow(
    healthy: healthy,
    listening: listening,
    named: blocked,
    port: port,
    budget: lockBudget,
    poll: poll,
    sleep: sleep,
    now: now,
  );
}

Future<PortState> _waitOrThrow({
  required Future<bool> Function() healthy,
  required Future<bool> Function() listening,
  required Future<PortHolder?> Function() named,
  required String port,
  required Duration budget,
  required Duration poll,
  required Future<void> Function(Duration) sleep,
  required DateTime Function() now,
}) async {
  final until = now().add(budget);
  while (true) {
    if (await healthy()) return PortState.adopted;
    if (!now().isBefore(until)) break;
    await sleep(poll);
    // It may have answered or let go while we waited.
    if (!await listening() && await named() == null) return PortState.free;
  }
  final who = await named();
  throw BackendNotReady(
    _message(who, port),
    holderPid: who?.pid,
    holderIsOurs: who?.isOurs ?? false,
  );
}

String _message(PortHolder? who, String port) {
  if (who == null) {
    return 'Port $port is already in use by something that is not answering. It may still be starting, and this window keeps trying on its own, so press Try again in a moment.';
  }
  if (!who.isOurs) {
    return 'Another program (pid ${who.pid}) is using port $port. Close it and press Try again.';
  }
  if (!who.onPort) {
    return 'FarFromDesk is still running in the background (pid ${who.pid}) but it never finished starting, and it is holding this app data folder. This window keeps trying on its own; to start now, quit that copy.';
  }
  return 'FarFromDesk is still running in the background (pid ${who.pid}) but it has stopped answering on port $port. This window keeps trying on its own; to start now, quit that copy.';
}
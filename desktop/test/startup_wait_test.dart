import 'package:farfromdesk/startup_wait.dart';
import 'package:flutter_test/flutter_test.dart';

/// A clock that advances with the injected sleep, so the wait's budget is tested
/// without spending it.
class _Clock {
  DateTime at = DateTime(2026, 1, 1);
  Future<void> sleep(Duration d) async => at = at.add(d);
}

void main() {
  test('a free port is free, and health is asked only once', () async {
    final clock = _Clock();
    var healthy = 0;
    final state = await awaitPortOrAdopt(
      healthy: () async {
        healthy++;
        return false;
      },
      listening: () async => false,
      holder: () async => null,
      port: '47961',
      sleep: clock.sleep,
      now: () => clock.at,
    );
    expect(state, PortState.free);
    expect(healthy, 1);
  });

  test('a backend that answers is adopted, not raced', () async {
    final clock = _Clock();
    final state = await awaitPortOrAdopt(
      healthy: () async => true,
      listening: () async => true,
      holder: () async => null,
      port: '47961',
      sleep: clock.sleep,
      now: () => clock.at,
    );
    expect(state, PortState.adopted);
  });

  test('a port that frees itself is free again, so the launch goes ahead', () async {
    final clock = _Clock();
    var listening = true;
    final state = await awaitPortOrAdopt(
      healthy: () async => false,
      listening: () async => listening,
      holder: () async => null,
      port: '47961',
      sleep: (d) async {
        listening = false;
        await clock.sleep(d);
      },
      now: () => clock.at,
    );
    expect(state, PortState.free);
  });

  test('a wedged older copy is named, with the pid and the way out', () async {
    final clock = _Clock();
    await expectLater(
      awaitPortOrAdopt(
        healthy: () async => false,
        listening: () async => true,
        holder: () async => const PortHolder(48712, isOurs: true),
        port: '47961',
        sleep: clock.sleep,
        now: () => clock.at,
      ),
      throwsA(
        isA<BackendNotReady>()
            .having((e) => e.holderPid, 'holderPid', 48712)
            .having((e) => e.holderIsOurs, 'holderIsOurs', true)
            .having((e) => e.message, 'message', contains('48712'))
            .having((e) => e.message, 'message', contains('quit that copy'))
            // The wording that sent the owner looking for a port problem.
            .having(
              (e) => e.message,
              'message',
              isNot(contains('Check that port')),
            ),
      ),
    );
  });

  test('a copy that holds the data folder without answering is named too', () async {
    final clock = _Clock();
    await expectLater(
      awaitPortOrAdopt(
        healthy: () async => false,
        listening: () async => false,
        holder: () async => null,
        lockHolder: () async => const PortHolder(79775, isOurs: true, onPort: false),
        port: '47961',
        sleep: clock.sleep,
        now: () => clock.at,
      ),
      throwsA(
        isA<BackendNotReady>()
            .having((e) => e.holderPid, 'holderPid', 79775)
            .having((e) => e.holderIsOurs, 'holderIsOurs', true)
            .having((e) => e.message, 'message', contains('never finished starting'))
            .having((e) => e.message, 'message', contains('79775')),
      ),
    );
  });

  test('a data folder held by nobody leaves the launch to proceed', () async {
    final clock = _Clock();
    final state = await awaitPortOrAdopt(
      healthy: () async => false,
      listening: () async => false,
      holder: () async => null,
      lockHolder: () async => null,
      port: '47961',
      sleep: clock.sleep,
      now: () => clock.at,
    );
    expect(state, PortState.free);
  });

  test('an unidentified holder is still reported as a busy port', () async {
    final clock = _Clock();
    await expectLater(
      awaitPortOrAdopt(
        healthy: () async => false,
        listening: () async => true,
        holder: () async => null,
        port: '47961',
        sleep: clock.sleep,
        now: () => clock.at,
      ),
      throwsA(
        isA<BackendNotReady>()
            .having((e) => e.holderPid, 'holderPid', isNull)
            .having((e) => e.holderIsOurs, 'holderIsOurs', false)
            .having((e) => e.message, 'message', contains('47961')),
      ),
    );
  });
}
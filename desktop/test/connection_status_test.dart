import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/connection_status.dart';

void main() {
  test(
    'native check failures and API configuration are not displayed as sign-in failures',
    () {
      Map platform(String state, {bool create = false, String mode = 'cli'}) => {
        'available': true,
        'executionMode': mode,
        'canCreate': create,
        'connection': {'state': state},
      };
      // Each row names what it is first, then its state, so a diagnostic never reads as a state.
      expect(
        platformConnectionStatus(platform('unknown')),
        'Terminal · Check required',
      );
      expect(
        platformConnectionStatus(platform('signed-out')),
        'Terminal · Sign in required',
      );
      expect(
        platformConnectionStatus(platform('configured', create: true)),
        'Terminal · Token ready',
      );
      expect(
        platformConnectionStatus(platform('verified', create: true)),
        'Terminal · Ready',
      );
      expect(
        platformConnectionStatus(
          platform('verified', create: true, mode: 'desktop'),
        ),
        'App · Ready',
      );
      expect(
        platformConnectionStatus({'available': false}),
        'Terminal · Needs setup',
      );
      expect(
        platformConnectionStatus({
          'available': false,
          'executionMode': 'desktop',
        }),
        'App · Needs setup',
      );
    },
  );
}
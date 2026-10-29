import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/connection_status.dart';

void main() {
  test('native check failures and API configuration are not displayed as sign-in failures', () {
    Map platform(String state, {bool create = false}) => {
      'available': true,
      'executionMode': 'cli',
      'canCreate': create,
      'connection': {'state': state},
    };
    expect(platformConnectionStatus(platform('unknown')), 'Check unavailable');
    expect(
      platformConnectionStatus(platform('signed-out')),
      'Sign in or configure API',
    );
    expect(
      platformConnectionStatus(platform('configured', create: true)),
      'API / token configured',
    );
    expect(
      platformConnectionStatus(platform('verified', create: true)),
      'Terminal · Available',
    );
    expect(platformConnectionStatus({'available': false}), 'Not detected');
  });
}

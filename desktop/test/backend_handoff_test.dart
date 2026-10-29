import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/native_gateway.dart';

void main() {
  test('only a strictly older release backend is replaced', () {
    expect(compareBuilds('0.8.0', '0.9.2'), lessThan(0));
    expect(compareBuilds('0.9.2', '0.9.3-beta.1'), lessThan(0));
    expect(compareBuilds('0.9.3', '0.9.2'), greaterThan(0));
    expect(compareBuilds('0.9.2', '0.9.2'), 0);
    expect(compareBuilds(null, '0.9.2'), isNull);
    expect(compareBuilds('dev-123', '0.9.2'), isNull);
  });
}

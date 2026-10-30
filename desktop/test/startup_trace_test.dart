import 'package:flutter_test/flutter_test.dart';
import 'package:farfromdesk/startup_trace.dart';

void main() {
  test('startup diagnostics are safe in native and browser previews', () {
    expect(() => traceStartup('test stage'), returnsNormally);
  });
}

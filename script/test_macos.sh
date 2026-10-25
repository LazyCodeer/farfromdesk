#!/usr/bin/env bash
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFTC_BIN="$(xcrun --find swiftc)"
TEST_PLUGIN="$(dirname "$SWIFTC_BIN")/../lib/swift/host/plugins/testing/libTestingMacros.dylib"
TEST_FLAGS=()
# Some Command Line Tools builds omit Swift Testing's automatic plugin lookup.
if [[ -f "$TEST_PLUGIN" ]]; then
  TEST_FLAGS=(-Xswiftc -load-plugin-library -Xswiftc "$TEST_PLUGIN")
fi
exec swift test --package-path "$BRIDGE_ROOT/macos" --disable-xctest "${TEST_FLAGS[@]}"

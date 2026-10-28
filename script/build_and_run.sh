#!/usr/bin/env bash
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
# Explicit local phone trial never stops/replaces the production app.
if [[ "$MODE" == "--phone-preview" ]]; then
  shift
  exec python3 "$BRIDGE_ROOT/script/build_phone_preview.py" "$@"
fi
case "$MODE" in run|--verify|--build-only|--debug|--logs|--telemetry) ;; *) echo "Unknown mode: $MODE" >&2; exit 2;; esac
cd "$BRIDGE_ROOT"
# Stop only the UI executable; the Node background bridge retains its connection.
if [[ "$MODE" != "--build-only" ]]; then pkill -x SessionBridge >/dev/null 2>&1 || true; fi
npm run build
"${WSB_BUILD_PYTHON:-python3.12}" script/build_speech_runtime.py
swift build --package-path macos
python3 script/package_macos.py
BRIDGE_APP="$BRIDGE_ROOT/build/Session Bridge.app"
case "$MODE" in
  --build-only) exit 0 ;;
  --debug) exec lldb -- "$BRIDGE_APP/Contents/MacOS/SessionBridge" ;;
  *) /usr/bin/open "$BRIDGE_APP" ;;
esac
case "$MODE" in
  --verify) sleep 2; pgrep -x SessionBridge >/dev/null ;;
  --logs) /usr/bin/log stream --info --predicate 'process == "SessionBridge"' ;;
  --telemetry) /usr/bin/log stream --info --predicate 'subsystem == "app.sessionbridge.mac"' ;;
esac

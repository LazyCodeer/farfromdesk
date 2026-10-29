#!/bin/bash
# The optional script argument is used only by isolated tests. CI runs the
# unmodified packaged-app supervisor; this wrapper never interprets its output.
set -u
supervisor_script=${1:-script/smoke_supervisor.mjs}
diagnostic_dir=$(mktemp -d "${RUNNER_TEMP:?}/ffd-diagnostic.XXXXXX")
export FFD_DIAGNOSTIC_DIR="$diagnostic_dir"
node --import ./script/intel_diagnostic_heartbeat.mjs "$supervisor_script" &
smoke_pid=$!
python3 script/intel_smoke_observer.py --root-pid "$smoke_pid" --heartbeat "$diagnostic_dir/supervisor-heartbeat" > "$RUNNER_TEMP/intel-diagnostic.jsonl" &
observer_pid=$!
tail -n +1 -f "$RUNNER_TEMP/intel-diagnostic.jsonl" &
tail_pid=$!
printf 'Diagnostic helper PIDs: %s %s\n' "$observer_pid" "$tail_pid"
smoke_finished=0
# shellcheck disable=SC2329 # invoked by EXIT trap
cleanup() {
  # Only signal this shell's still-running direct child on cancellation. The
  # supervisor's detached descendants are deliberately not guessed or killed.
  if [ "$smoke_finished" -eq 0 ]; then
    for running_pid in $(jobs -pr); do
      if [ "$running_pid" = "$smoke_pid" ]; then
        kill -KILL "$smoke_pid" 2>/dev/null || true
      fi
    done
  fi
  kill "$observer_pid" "$tail_pid" 2>/dev/null || true
  wait "$observer_pid" "$tail_pid" 2>/dev/null || true
  rm -rf "$diagnostic_dir"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
set +e
wait "$smoke_pid"
result=$?
smoke_finished=1
set -e
exit "$result"

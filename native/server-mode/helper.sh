#!/bin/sh
# FarFromDesk server mode helper.
#
# Installed once with admin approval and run by a LaunchDaemon as root. Its only
# job is to decide, every few seconds, whether system sleep may stay disabled so
# the Mac keeps working with the lid shut.
#
# Sleep stays disabled only while ALL of these hold:
#   1. the app's state file exists, is owned by the installing user, and parses;
#   2. that file says enabled=true;
#   3. its heartbeat was written within MAX_AGE seconds;
#   4. the Mac is drawing from AC power.
# Anything else - app quit, app crash, app removed, battery, malformed file,
# reboot with a stale heartbeat - restores normal sleep. That is the dead-man's
# switch, and 0 is always the default.
#
# This script never reads anything else, never executes app input, and takes no
# arguments from the app. The app cannot ask it to run a command.
set -u

STATE="${FFD_STATE_FILE:-}"
EXPECT_UID="${FFD_STATE_UID:-}"
PMSET="${FFD_PMSET:-/usr/bin/pmset}"
INTERVAL="${FFD_INTERVAL:-5}"
MAX_AGE="${FFD_HEARTBEAT_MAX_AGE:-180}"
MODE="${1:-watch}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Why sleep must NOT stay disabled, or "ok" when it may.
reason() {
  if [ -z "$STATE" ] || [ -z "$EXPECT_UID" ] || [ ! -f "$STATE" ]; then
    echo "no-state"; return
  fi
  owner="$(/usr/bin/stat -f %u "$STATE" 2>/dev/null)" || { echo "no-state"; return; }
  if [ "$owner" != "$EXPECT_UID" ]; then echo "wrong-owner"; return; fi
  enabled="$(/usr/bin/plutil -extract enabled raw -o - "$STATE" 2>/dev/null)" || { echo "bad-state"; return; }
  if [ "$enabled" != "true" ]; then echo "disabled"; return; fi
  mtime="$(/usr/bin/stat -f %m "$STATE" 2>/dev/null)" || { echo "bad-state"; return; }
  now="$(date +%s)"
  if [ $((now - mtime)) -gt "$MAX_AGE" ]; then echo "stale-heartbeat"; return; fi
  if ! "$PMSET" -g batt 2>/dev/null | /usr/bin/head -n 1 | /usr/bin/grep -q "AC Power"; then
    echo "on-battery"; return
  fi
  echo "ok"
}

sleep_disabled() {
  "$PMSET" -g 2>/dev/null | /usr/bin/awk '/SleepDisabled/ {print $2; exit}'
}

apply() {
  wanted="$(reason)"
  if [ "$wanted" = "ok" ]; then
    if [ "$(sleep_disabled)" != "1" ]; then
      if "$PMSET" -a disablesleep 1 >/dev/null 2>&1; then
        log "lid-closed sleep disabled (server mode on, on power)"
      else
        log "could not disable sleep; leaving normal sleep in place"
      fi
    fi
    return 0
  fi
  if [ "$(sleep_disabled)" != "0" ]; then
    if "$PMSET" -a disablesleep 0 >/dev/null 2>&1; then
      log "normal sleep restored ($wanted)"
    else
      log "could not restore normal sleep ($wanted)"
    fi
  fi
}

restore() {
  [ "$(sleep_disabled)" = "0" ] || "$PMSET" -a disablesleep 0 >/dev/null 2>&1
}

case "$MODE" in
  --once)
    # Single decision, for tests and diagnostics. Prints the reason and result;
    # never loops.
    wanted="$(reason)"
    apply
    printf 'reason=%s sleep=%s\n' "$wanted" "$(sleep_disabled)"
    ;;
  *)
    # If this helper is stopped or unloaded, normal sleep comes back first.
    trap 'log "helper stopping; restoring normal sleep"; restore; exit 0' TERM INT HUP
    while :; do
      apply
      sleep "$INTERVAL"
    done
    ;;
esac

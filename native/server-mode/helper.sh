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
#   3. its heartbeat is younger than GRACE_MAX_AGE seconds;
#   4. the Mac is drawing from AC power.
#
# MAX_AGE splits rule 3 into the two states worth telling apart. A heartbeat
# younger than MAX_AGE means the app is running. Between MAX_AGE and
# GRACE_MAX_AGE the app is gone - killed, hung, or lost with the machine - and
# the Mac stays awake for that bounded window so the app can come back and the
# owner can still reach it. Past GRACE_MAX_AGE, or on battery, or with a state
# file that is missing, foreign or unparsable, normal sleep returns.
#
# Turning the setting off writes enabled=false and returns normal sleep at once.
# A shutdown on its own does not: the app is a KeepAlive agent and restarts are
# routine, so releasing the hold there would open a window in which a lid-closed
# Mac could sleep.
#
# This script never reads anything else, never executes app input, and takes no
# arguments from the app. The app cannot ask it to run a command.
set -u

# Read by src/server-mode.ts to decide whether the installed copy is out of date.
FFD_HELPER_VERSION=2

STATE="${FFD_STATE_FILE:-}"
EXPECT_UID="${FFD_STATE_UID:-}"
PMSET="${FFD_PMSET:-/usr/bin/pmset}"
INTERVAL="${FFD_INTERVAL:-5}"
MAX_AGE="${FFD_HEARTBEAT_MAX_AGE:-180}"
GRACE_MAX_AGE="${FFD_GRACE_MAX_AGE:-7200}"
MODE="${1:-watch}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Why sleep must NOT stay disabled, "grace" while the app is away but its window
# is still open, or "ok" when the app is running.
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
  age=$((now - mtime))
  if [ "$age" -gt "$GRACE_MAX_AGE" ]; then echo "stale-heartbeat"; return; fi
  if ! "$PMSET" -g batt 2>/dev/null | /usr/bin/head -n 1 | /usr/bin/grep -q "AC Power"; then
    echo "on-battery"; return
  fi
  if [ "$age" -gt "$MAX_AGE" ]; then echo "grace"; return; fi
  echo "ok"
}

sleep_disabled() {
  "$PMSET" -g 2>/dev/null | /usr/bin/awk '/SleepDisabled/ {print $2; exit}'
}

# Takes the reason when the caller already has it, so one pass makes one decision.
apply() {
  wanted="${1:-$(reason)}"
  case "$wanted" in
    ok|grace)
      if [ "$(sleep_disabled)" != "1" ]; then
        if "$PMSET" -a disablesleep 1 >/dev/null 2>&1; then
          if [ "$wanted" = "grace" ]; then
            log "lid-closed sleep disabled (app heartbeat gone, inside the grace window)"
          else
            log "lid-closed sleep disabled (server mode on, on power)"
          fi
        else
          log "could not disable sleep; leaving normal sleep in place"
        fi
      fi
      return 0
      ;;
  esac
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
    apply "$wanted"
    printf 'reason=%s sleep=%s\n' "$wanted" "$(sleep_disabled)"
    ;;
  *)
    # If this helper is stopped or unloaded, normal sleep comes back first.
    trap 'log "helper stopping; restoring normal sleep"; restore; exit 0' TERM INT HUP
    previous=""
    while :; do
      wanted="$(reason)"
      # Entering the window is the one state change the app cannot report itself,
      # because the app being gone is what starts it.
      if [ "$wanted" = "grace" ] && [ "$previous" != "grace" ]; then
        log "app heartbeat missing; holding sleep off for at most ${GRACE_MAX_AGE}s"
      fi
      previous="$wanted"
      apply "$wanted"
      sleep "$INTERVAL"
    done
    ;;
esac
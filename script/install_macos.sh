#!/usr/bin/env bash
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_SOURCE="$BRIDGE_ROOT/build/Session Bridge.app"
BRIDGE_DEST="$HOME/Applications/Session Bridge.app"
case "${1:-}" in ""|--replace) ;; *) echo "Usage: $0 [--replace]" >&2; exit 2;; esac
if [[ ! -d "$BRIDGE_SOURCE" ]]; then
  echo "Build first with ./script/build_and_run.sh --build-only" >&2
  exit 1
fi
codesign --verify --deep --strict "$BRIDGE_SOURCE"
if [[ -L "$BRIDGE_DEST" ]]; then
  echo "Refusing to replace an app symlink." >&2
  exit 1
fi
if [[ -e "$BRIDGE_DEST" && "${1:-}" != "--replace" ]]; then
  echo "An app already exists at $BRIDGE_DEST. Keep it or move it before installing this build." >&2
  exit 1
fi
pkill -x SessionBridge >/dev/null 2>&1 || true
mkdir -p "$HOME/Applications"
if [[ -e "$BRIDGE_DEST" ]]; then
  BRIDGE_BACKUP="$HOME/Applications/Session Bridge.backup-$(date +%Y%m%d-%H%M%S)-$$.app"
  mv "$BRIDGE_DEST" "$BRIDGE_BACKUP"
  echo "Previous app saved at $BRIDGE_BACKUP"
fi
ditto "$BRIDGE_SOURCE" "$BRIDGE_DEST"
codesign --verify --deep --strict "$BRIDGE_DEST"
/usr/bin/open "$BRIDGE_DEST"
echo "Installed $BRIDGE_DEST"

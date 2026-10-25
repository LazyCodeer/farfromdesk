#!/bin/sh
# FarFromDesk user-local desktop installer. No sudo, package manager, or browser UI.
set -eu
umask 077
version=${FFD_VERSION:-0.7.1}
case "$version" in ''|*[!A-Za-z0-9._-]*) echo 'Invalid release version.' >&2; exit 1;; esac
case "$(uname -s)" in Darwin) os=macos;; Linux) os=linux;; *) echo 'Use install.ps1 on Windows.' >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) echo 'This CPU is not supported.' >&2; exit 1;; esac
if [ "$os" = linux ] && [ "$arch" != x64 ]; then echo 'Linux arm64 builds are not available for this release.' >&2; exit 1; fi
extension=tar.gz; [ "$os" != macos ] || extension=zip
asset="FarFromDesk-$version-$os-$arch.$extension"
base=${FFD_RELEASE_BASE:-https://github.com/LazyCodeer/farfromdesk/releases/download/v$version}
case "$base" in https://*) ;; *) echo 'Release base must use HTTPS.' >&2; exit 1;; esac
if [ "${FFD_DRY_RUN:-0}" = 1 ]; then printf '%s\n' "$base/$asset"; exit 0; fi
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
temp=$(mktemp -d "${TMPDIR:-/tmp}/farfromdesk.XXXXXXXX")
trap 'rm -rf "$temp"' EXIT HUP INT TERM
download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$1" --output "$2" || {
    echo 'Release download failed. The release may be unpublished or be temporarily unavailable. No app was installed.' >&2; exit 1;
  }
}
printf 'Downloading FarFromDesk %s for %s %s…\n' "$version" "$os" "$arch"
download "$base/$asset" "$temp/$asset"
download "$base/$asset.sha256" "$temp/checksum"
expected=$(awk 'NR==1 {print $1}' "$temp/checksum")
case "$expected" in *[!a-fA-F0-9]*|'') echo 'Invalid release checksum.' >&2; exit 1;; esac
[ "${#expected}" = 64 ] || { echo 'Invalid release checksum length.' >&2; exit 1; }
if command -v shasum >/dev/null; then actual=$(shasum -a 256 "$temp/$asset" | awk '{print $1}'); else actual=$(sha256sum "$temp/$asset" | awk '{print $1}'); fi
[ "$actual" = "$expected" ] || { echo 'Checksum mismatch. Installation stopped.' >&2; exit 1; }
mkdir "$temp/unpack"
if [ "$os" = macos ]; then
  unzip -Z1 "$temp/$asset" > "$temp/entries"
else
  tar -tzf "$temp/$asset" > "$temp/entries"
fi
# Reject absolute/traversing member names before extraction.
if LC_ALL=C grep -E '(^/|(^|/)\.\.(/|$)|\\)' "$temp/entries" >/dev/null; then echo 'Unsafe archive path.' >&2; exit 1; fi
if [ "$os" = macos ]; then
  /usr/bin/ditto -x -k "$temp/$asset" "$temp/unpack"
  app="$HOME/Applications/FarFromDesk.app"
  [ -d "$temp/unpack/FarFromDesk.app/Contents/MacOS" ] || { echo 'Invalid application bundle.' >&2; exit 1; }
  mkdir -p "$HOME/Applications"
  backup="$HOME/Applications/FarFromDesk.previous.$(date +%s).app"
  if [ -e "$app" ]; then mv "$app" "$backup"; fi
  if ! mv "$temp/unpack/FarFromDesk.app" "$app"; then
    [ ! -e "$backup" ] || mv "$backup" "$app"
    echo 'Installation failed; previous app restored.' >&2; exit 1
  fi
  printf 'Installed %s\n' "$app"
  echo 'macOS signing and security checks remain enabled.'
  [ "${FFD_NO_LAUNCH:-0}" = 1 ] || /usr/bin/open "$app"
else
  tar -xzf "$temp/$asset" -C "$temp/unpack" --no-same-owner --no-same-permissions
  [ -x "$temp/unpack/FarFromDesk/farfromdesk" ] || { echo 'Invalid desktop bundle.' >&2; exit 1; }
  root="$HOME/.local/opt/farfromdesk"; target="$root/$version"
  [ ! -e "$target" ] || { echo 'This version is already installed. Open it from your application menu.'; exit 0; }
  mkdir -p "$root" "$HOME/.local/share/applications"
  mv "$temp/unpack/FarFromDesk" "$target"
  # Desktop-entry quoting: escape backslashes, quotes, dollars, backticks and field codes.
  escaped=$(printf '%s' "$target/farfromdesk" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g; s/%/%%/g')
  printf '[Desktop Entry]\nType=Application\nName=FarFromDesk\nComment=Your work, within reach\nExec="%s"\nTerminal=false\nCategories=Development;Utility;\n' "$escaped" > "$HOME/.local/share/applications/farfromdesk.desktop"
  printf 'Installed %s\nOpen FarFromDesk from your application menu.\n' "$target"
  if [ "${FFD_NO_LAUNCH:-0}" != 1 ]; then "$target/farfromdesk" >/dev/null 2>&1 & fi
fi
echo 'Pair WhatsApp and enable background forwarding inside FarFromDesk. Account data stays outside the app installation.'

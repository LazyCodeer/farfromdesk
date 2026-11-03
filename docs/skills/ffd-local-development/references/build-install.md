# Local build and install

## Before building

Read current-state.md and verify source and installed metadata with:

```sh
rtk proxy python3 /Users/sagar/.codex/skills/ffd-local-development/scripts/inspect_local.py
```

Never assume the last recorded build number is still latest. Use a new build number greater than the installed one. Preserve the existing normal Codex profile and Local state defines. No Apple developer certificate was present during this work; the owner previously authorized ad-hoc Local signing, but the current task's instructions still control installation/restarts. Do not grant macOS Accessibility prompts yourself.

## Build

From the actual source root:

```sh
rtk proxy npm run build
```

From its `desktop/` directory (substitute NEXT_BUILD with the chosen integer):

```sh
rtk proxy /Volumes/Personal/DevTools/flutter/bin/flutter build macos --release --no-pub --build-number=NEXT_BUILD --dart-define=FFD_ISOLATED_LOCAL=true '--dart-define=FFD_LOCAL_STATE=/Users/sagar/Library/Application Support/FarFromDesk Local' --dart-define=FFD_LOCAL_PORT=47961 --dart-define=FFD_LOCAL_CODEX_HOME=/Users/sagar/.codex
```

The build output is `desktop/build/macos/Build/Products/Release/FarFromDesk Local.app`. It is only the Flutter bundle until packaged with backend resources. Wait for command completion before copying it. A running exec session is not a completed build.

## Package

Create a fresh task artifact folder outside Applications. Copy the new Flutter app there. Copy existing installed Local `Contents/Resources/backend` and `speech` (when present) to retain runtime, native helpers and dependencies. Overlay current source `dist/`, `skills/` **and `native/`** into staged `Contents/Resources/backend/`. This copies app resources, not app state.

The carry-forward is only right for the compiled native helpers, whose bytes the macOS grants are bound to; `ditto` merges, so overlaying `native/` refreshes the sources without touching a binary that exists only in the installed app. Until 2379 the stage took all of `native/` from the installed bundle and overlaid only `dist/` and `skills/`, so a change to anything under `native/` could not ship at all: `native/server-mode/helper.sh` was rewritten in the checkout, sat unchanged in the installed app through a build, and the version guard that replaced it then refused to install. `script/prepare_desktop_backend.mjs` builds a backend payload that this workflow never uses, so do not read it as the source of the staged backend.

Update staged backend/build.json with a descriptive Local buildId, localSource and `localChanges:true`. Preserve provenance honestly; a copied sourceCommit is not an exact commit for uncommitted local changes. Confirm bundle ID `com.codecylabs.farfromdesk.localtest` and chosen version before signing.

For an authorized ad-hoc Local build:

```sh
rtk proxy /usr/bin/codesign --force --sign - --identifier com.codecylabs.farfromdesk.localtest --preserve-metadata=entitlements '/absolute/stage/FarFromDesk Local.app'
rtk proxy /usr/bin/codesign --verify --deep --strict '/absolute/stage/FarFromDesk Local.app'
rtk proxy node /Users/sagar/.codex/skills/ffd-local-development/scripts/packaged_smoke.mjs '/absolute/stage/FarFromDesk Local.app'
```

The normal signing script expects an Apple identity and rejects ad-hoc signing. Do not edit that production-oriented script to remove its requirement; use the explicit Local signing path when authorized. Re-sign and verify after any bundle mutation.

The smoke starts only the packaged backend, in a fresh temporary HOME/state/Codex/Claude profile with unavailable provider binaries. It checks authenticated startup, no-token 401, paused clean state, empty Social drafts, default source and graceful shutdown. It reads only the synthetic admin token it just created. It does not prove live owner routing, native permissions or Meta access.

## Replace Local only when authorized

1. Save the currently installed Local bundle as an external recoverable `.bundle` archive. Do not back up private Application Support data.
2. Copy the verified stage to a temporary `.bundle` on the Applications filesystem; wait for copy completion, then verify it again.
3. Inspect `ps -axo pid,ppid,comm`. Send SIGTERM only to processes whose executable path starts with the exact installed **FarFromDesk Local.app/** path. Stop UI/backend first, then remaining Local helpers if necessary. Recheck PIDs before acting. If processes do not exit gracefully, stop installation and report; do not blanket-kill node, Codex, Claude or production FarFromDesk.
4. Rename installed Local to a temporary rollback `.bundle`; rename the new bundle to the exact original `FarFromDesk Local.app` path. If replacement fails, restore the old name.
5. Launch the exact app with `/usr/bin/open`. Verify installed version, actual process paths and Local loopback response. A 401 without a token establishes only reachability. Do not read saved keys/tokens to make a stronger claim without authorization.
6. Retain the external rollback copy; remove only the temporary rollback copy created by this install after verification. Keep one installed Local app.

Record source, version, build ID, tests, install verification and remaining owner checks. Do not turn a Local install into a public release, production deployment or live paid test.

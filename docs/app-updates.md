# In-app updates

macOS now offers **Update and restart**. One explicit click downloads the official architecture-specific ZIP, displays byte progress, verifies the checksum and app, checks for active work, quits FarFromDesk, replaces its bundle and reopens it. No browser download, DMG mounting or drag-to-Applications step is needed. The backend rejects the restart if native dispatch, approvals or session creation are active. Queued requests do not prevent an update; their ledger and pairing stay outside the app.

The helper uses the bundled Node runtime and runs independently while restarting the UI. It preserves one previous app at `.FarFromDesk-previous.app` beside the installed app and saves a request database snapshot in the private `app-update` state directory before replacement. It never requests sudo or silently elevates permissions. An unwritable installation location produces an actionable error before shutdown. If replacing the bundle or submitting its launch fails, the previous app is restored; an unconfirmed startup after launch retains the previous bundle and database snapshot for diagnosis without restoring a potentially stale database over new requests.

## Validation and trust

The helper re-fetches the exact public GitHub release, accepts only uploaded ZIP/checksum assets from `LazyCodeer/farfromdesk`, bounds metadata/download/unpacked sizes and free-space requirements, streams SHA-256 verification and restricts redirects to HTTPS GitHub asset hosts. ZIP paths are checked and macOS sandboxing confines extraction writes to staging; bundle links cannot escape. Code signatures, bundle identifier, architecture and release version are checked. A team-signed installed app requires the same team for its update. Existing ad-hoc releases rely on the official HTTPS release/checksum channel; this does not turn them into notarized or independently signed update feeds. No quarantine, Gatekeeper or trust settings are changed.

The authenticated update-shutdown endpoint is administrator-only. The installed UI checks both source revision and build identity when connecting, so an older backend from the same commit cannot be mistaken for the new build. Successful installation requires the restarted backend to report the expected revision and release identity.

## Version and platform behavior

Checks retain the existing six-hour cache, manual rate limit and small public GitHub metadata request. No provider credentials, messages or machine identifiers are sent. Offline/error responses are not reported as proof that the app is up to date.

Local versions such as `0.7.1-local.2023` treat `0.7.1` as their public baseline: they do not offer the same public version or previews, and can upgrade to a newer stable core version. Preview builds retain semantic ordering. macOS uses ZIP for automatic installation. Windows x64 EXE installations use the Windows flow below. Linux and portable Windows ZIP installations require a manual update.

## Windows EXE updates

The native Windows UI offers **Update and restart** for an official x64 EXE release. It copies the updater modules and bundled Node executable to a unique directory under the user's saved state before starting the helper. Neither the updater executable nor its working directory lives in the installation being replaced. This avoids the previous problem where the application or backend kept files locked during setup.

The helper checks that the running UI and backend belong to the same existing, per-user Inno installation, with one matching uninstall entry and the expected old build identity. Multiple open copies, a portable installation, linked folders and mismatched registry paths fail before shutdown. Downloads use the existing bounded HTTPS and SHA-256 checks; the shipped CLI has no custom-feed or local-package override. Unsigned releases still rely on the official GitHub release and checksum channel, not independent publisher signing.

After downloading, the authenticated shutdown endpoint refuses active requests, pending approvals or session creation. The helper waits for the backend to exit, copies the application and request database into the attempt's recovery directory, then sends a normal window-close request to the exact UI process after rechecking its start time and executable. It waits for that process to exit too. It never uses a blanket process kill or automatically answers a native prompt.

The verified EXE runs with the existing installation directory, suppressed installer wizard, no forced application closing, and no automatic reboot. The existing AppId remains unchanged. The helper verifies the resulting uninstall entry, build version and revision, reopens the app with the same saved-state location, and checks authenticated backend health against that version and revision. The restarted UI displays the saved completion or error result. This check confirms backend startup, not reconnection to every messaging provider.

Failures before installer execution leave the original installation in place. If its UI is still open, it reconnects to the original backend; if it exited, the helper reopens it. Once the installer runs, a failure or uncertain outcome retains the installer log, previous application and database snapshot. It does not replay the installer or restore a database that could contain older requests. Code 3010 asks the owner to restart Windows. A stalled helper retains its lock for diagnosis rather than allowing a competing update. Recovery files contain private account data and must not be uploaded as public artifacts.

### Verification

`test/windows-updater.test.ts` exercises installation identity, package selection, shutdown ordering, process-exit failures, installer errors and startup failure. Flutter tests cover the restart outcome dialog and existing explicit-click/progress flow. These tests do not prove a native Windows upgrade works.

The no-publish workflow `.github/workflows/windows-upgrade.yml` builds a disposable candidate and verifies the published v0.8.0 EXE's checksum. `script/test_windows_upgrade.mjs` installs that older release into a disposable folder, starts the actual native UI and backend with synthetic account state, enables background forwarding, then runs the real updater against the candidate. Only release transport is supplied by the test; installation, registry checks, native window closing, process waiting, restart and authenticated health are real. Assertions cover the new build, saved preference, unchanged admin token, database backup and Start menu shortcut target. The harness refuses an account with an existing installation. Run it in a disposable Windows user/runner, never over an owner's app.

The native Windows test must pass before shipping this change. Versions through 0.9.0 contain the manual Windows download flow; they need one manual upgrade to acquire the in-app updater.

Already-installed builds containing only the download notifier need one update to acquire this functionality. A future published compatible release is required to exercise a real production upgrade. Local checks use mocked HTTP, disposable files/app bundles, real macOS sandboxed ZIP extraction and native packaged-app smoke testing; they do not invent a release or downgrade the user's app.

## Short installation command

The live website redirects `/install.sh` to the official latest release installer:

```sh
curl -fsSL https://ffd.codecylabs.com/install.sh | sh
```

This is for first installation or manual recovery. The installer retains its internal platform, architecture and checksum checks. Normal subsequent macOS updates use the app button.

## Local verification — 26 October 2026

Installed as build 2023. Seven updater/API tests, 18 Flutter tests and Flutter analysis passed. The packaged native smoke test passed. The installed app reconnected to WhatsApp with voice ready; all 13 bindings, 9 pending requests and preferences were preserved. No newer public release was installed to simulate success; the production download-to-restart upgrade awaits a newer published release.

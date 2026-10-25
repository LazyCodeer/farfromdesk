# In-app updates

macOS now offers **Update and restart**. One explicit click downloads the official architecture-specific ZIP, displays byte progress, verifies the checksum and app, checks for active work, quits FarFromDesk, replaces its bundle and reopens it. No browser download, DMG mounting or drag-to-Applications step is needed. The backend rejects the restart if native dispatch, approvals or session creation are active. Queued requests do not prevent an update; their ledger and pairing stay outside the app.

The helper uses the bundled Node runtime and runs independently while restarting the UI. It preserves one previous app at `.FarFromDesk-previous.app` beside the installed app and saves a request database snapshot in the private `app-update` state directory before replacement. It never requests sudo or silently elevates permissions. An unwritable installation location produces an actionable error before shutdown. If replacing the bundle or submitting its launch fails, the previous app is restored; an unconfirmed startup after launch retains the previous bundle and database snapshot for diagnosis without restoring a potentially stale database over new requests.

## Validation and trust

The helper re-fetches the exact public GitHub release, accepts only uploaded ZIP/checksum assets from `LazyCodeer/farfromdesk`, bounds metadata/download/unpacked sizes and free-space requirements, streams SHA-256 verification and restricts redirects to HTTPS GitHub asset hosts. ZIP paths are checked and macOS sandboxing confines extraction writes to staging; bundle links cannot escape. Code signatures, bundle identifier, architecture and release version are checked. A team-signed installed app requires the same team for its update. Existing ad-hoc releases rely on the official HTTPS release/checksum channel; this does not turn them into notarized or independently signed update feeds. No quarantine, Gatekeeper or trust settings are changed.

The authenticated update-shutdown endpoint is administrator-only. The installed UI checks both source revision and build identity when connecting, so an older backend from the same commit cannot be mistaken for the new build. Successful installation requires the restarted backend to report the expected revision and release identity.

## Version and platform behavior

Checks retain the existing six-hour cache, manual rate limit and small public GitHub metadata request. No provider credentials, messages or machine identifiers are sent. Offline/error responses are not reported as proof that the app is up to date.

Local versions such as `0.7.1-local.2023` treat `0.7.1` as their public baseline: they do not offer the same public version or previews, and can upgrade to a newer stable core version. Preview builds retain semantic ordering. macOS uses ZIP for automatic installation. Windows and Linux still use their explicit manual download flow; unattended installation on those platforms is not implemented here.

Already-installed builds containing only the download notifier need one update to acquire this functionality. A future published compatible release is required to exercise a real production upgrade. Local checks use mocked HTTP, disposable files/app bundles, real macOS sandboxed ZIP extraction and native packaged-app smoke testing; they do not invent a release or downgrade the user's app.

## Short installation command

The live website redirects `/install.sh` to the official latest release installer:

```sh
curl -fsSL https://ffd.codecylabs.com/install.sh | sh
```

This is for first installation or manual recovery. The installer retains its internal platform, architecture and checksum checks. Normal subsequent macOS updates use the app button.

## Local verification — 26 October 2026

Installed as build 2023. Seven updater/API tests, 18 Flutter tests and Flutter analysis passed. The packaged native smoke test passed. The installed app reconnected to WhatsApp with voice ready; all 13 bindings, 9 pending requests and preferences were preserved. No newer public release was installed to simulate success; the production download-to-restart upgrade awaits a newer published release.

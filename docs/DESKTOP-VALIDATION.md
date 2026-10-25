# Shared desktop validation

The shared Flutter app and Node backend are integrated in `LazyCodeer/farfromdesk`. This document distinguishes automated release gates from account/device testing.

## Automated release gate

Every release is tied to an exact source commit and its [GitHub Actions run](https://github.com/LazyCodeer/farfromdesk/actions/workflows/desktop.yml). The release publisher refuses partial target sets, mismatched commits/checksums, unexpected files and public repository visibility. Feature branches do not publish.

| Target | Required native checks |
| --- | --- |
| macOS 14+ Apple Silicon | Flutter build; ad-hoc signature; ARM64 binaries; ZIP/DMG integrity; real packaged GUI startup |
| macOS 14+ Intel | Flutter build; ad-hoc signature; x64 binaries; ZIP/DMG integrity; real packaged GUI startup |
| Windows x64 | Flutter build; PE architecture; PowerShell installer parse/dry run; ZIP integrity; real packaged GUI startup |
| Linux x64, glibc 2.35+ | Flutter build; ELF architecture; installer fixtures; archive integrity; packaged GUI under Xvfb |

All targets run TypeScript checks, portable routing/permission/identity/locking tests, publication tests, Flutter analysis and three widget tests. Mac also runs the complete backend suite. Native startup uses disposable account state, isolated provider directories, an allocated loopback port, authenticated health/status/shutdown, and checks that bundled voice assets are ready. No pairing credentials or private conversations are uploaded to CI.

Real bundled speech checks use a fixed public English Ogg/Opus fixture, assert a plausible transcript, reject silence/corruption and verify scratch-recording cleanup. The x64 bundle includes baseline and optimized executables; an integrity-checked CPU probe chooses AVX2 only when CPU and OS support it. Probe failure or an older CPU retains the baseline. No runtime download or external transcription upload is involved.

## Observed integration results — 25 October 2026

The four-target checkpoint [40179656154](https://github.com/LazyCodeer/farfromdesk/actions/runs/40179656154) completed successfully at source `66992c4e8b2d9bc53de99a1860525f43a8c1c943`: both Mac architectures, Windows x64 and Linux x64 passed compilation, speech, packaging and rendered-UI startup. The full backend suite had 141 tests (140 passed, one optional audio test skipped); bundled audio was run separately and passed. The portable suite passed 23 tests. The 6.6-second public English fixture took 7.028 seconds through the Windows production transcription path with one thread. This excludes WhatsApp download, queueing and agent/reply time. Publication reruns the gates for its exact final commit, including the installer-byte normalization and explicit startup-migration option.

The Mac build at `ae2afdc` also passed the stricter rendered-UI check locally with disposable state. A single fresh, paused RSS sample measured approximately 289 MiB for app plus backend; this does not measure active transcription or provider-session memory.

- Local full backend suite: 140 tests, 139 passed, one optional installed-audio test skipped. Separate installed-audio validation is part of CI.
- Local portable subset: 19 passed, including process-crash lock recovery and exact-session authorization.
- Publication/packaging tests: 16 passed; Unix installer fixtures: three passed.
- Flutter analysis passed; three widget tests passed.
- Run [40175498121](https://github.com/LazyCodeer/farfromdesk/actions/runs/40175498121) passed Apple Silicon and Linux native startup, packaging and speech. Intel completed compilation, speech, packaging and startup. Windows compiled and started its staged backend, but its unoptimized speech test exceeded the three-minute outer limit. That run is **not a release candidate**. CPU selection and phase timing were added. The subsequent Windows log confirmed the optimized executable was selected but the last printed line was from its decoder. PCM is now sent through stdin; a subsequent log confirmed input was read but still timed out. Suppressed model logging did not establish the exact stalled phase, so a public-fixture diagnostic compared one and four threads with model logs enabled. Run 40179459760 completed with one thread in 7.09 seconds; four threads stalled during inference and exceeded 60 seconds. Windows now uses one thread; the full production-path voice test remains the release gate. Consult the latest run before considering Windows verified.
- The Apple Silicon package from commit `7a8d7381389b599f23d44e0abd135341d41ce740` was downloaded, its ZIP/DMG hashes and signature verified, and the real packaged process launched with a healthy backend on the owner's Mac with disposable state. Later review found a missing native login-startup handler that could prevent Home from rendering. That handler was added, and the gate now requires a UI-ready marker after startup registration is read and Home renders. The earlier process-level check alone is not evidence of a usable Home screen. The paired installation was not used in that test.

## Remaining manual gates

Automated passing results do not establish a real-phone round trip, provider sign-in/folder approval, saved-session resumption, file-picker UX, startup registration or lock/background behavior on every OS. Those require the corresponding device and account. Windows/Linux support CLI adapters; the Mac native Desktop transport remains available with its existing helper/account requirements.

Apple Developer ID signing/notarization and Windows signing are not configured. These are private previews, not signed public production downloads. Public installer endpoints have not been deployed. Do not bypass platform security settings.

## Mac migration safeguards

The app retains bundle ID `app.sessionbridge.mac` and the existing private state directory. A mismatched running backend is rejected rather than killed. A held SQLite service lock prevents two new backends from sharing one store; OS process exit releases it. Submitted requests are not replayed by restart; interrupted dispatches become uncertain for review.

Before replacing a legacy installation, verify the downloaded package, retain a private app/state backup, inspect in-flight work, stop only the identified legacy LaunchAgent/app, and confirm the replacement reconnects with the same bindings and history. Roll back if that fails. Keep backups and account data out of Git and release assets.

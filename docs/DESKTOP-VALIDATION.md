# Desktop validation

Validation date: 25 October 2026. This report covers the isolated `sidekick-windows` snapshot, not a published release or the running native Mac app.

## Local results

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm test` | 139 tests: 138 passed, 1 skipped, 0 failed |
| Focused HTTP and portable regression check | 9 passed |
| `python3 test/installers_test.py` | 3 passed; isolated fake-download fixtures cover paths with spaces, checksum mismatch and traversal rejection |
| `flutter analyze` | No issues |
| `flutter test` | 3 passed; consent, connected screens/dialog and 900×640 layout |
| Flutter web release preview | Built successfully using `lib/preview.dart` |
| `npm run desktop:backend` | Production backend and native Node staged for macOS arm64 |
| `node script/smoke_desktop_backend.mjs` | Passed: authenticated loopback API, paused clean install, isolated provider homes and graceful shutdown |

The complete backend suite was rerun after correcting the document-action test fixture; the counts above include that successful rerun. Tests use isolated state and do not establish a real WhatsApp connection.

## Design evidence

The shared Flutter screens use the existing FarFromDesk 0.6.2 build 41 native design, confirmed by its coding chat. See [Design parity](DESIGN-PARITY.md) for source mappings and deliberate platform differences.

Sample-data screenshots are saved in `preview-output/home.png`, `preview-output/activity.png` and `preview-output/settings.png`. Home, Activity and Settings were visually inspected in the local preview. They are Flutter browser renders used for design review; they are not evidence of a running native application, paired account or platform-specific permissions. Widget tests also exercise the master-session dialog and minimum desktop layout.

## Outstanding native and release verification

After Sagar explicitly approved the shared Flutter approach and requested replacing the installed app, `flutter build macos --release` was attempted on 25 October 2026. Dependency resolution succeeded, but the build exited with `Xcode not installed; this is necessary for iOS and macOS development.` `xcode-select -p` returns `/Library/Developer/CommandLineTools`, and Spotlight found no Xcode bundle. No native release app bundle was produced. The installed `~/Applications/Session Bridge.app`, its running backend and account state were left intact because a working replacement was not available. This is a missing toolchain blocker, not a completed installation or native runtime test.

- Native Flutter compilation and execution on macOS, Windows and Linux. This host has Flutter 3.47.7 but lacks full Xcode; Windows/Linux runners were unavailable in this workspace.
- PowerShell installer execution; the workflow includes parser and dry-run checks, but it has not run here.
- Platform startup registration, native file pickers, close/background behavior and Windows/Linux keep-awake behavior.
- Real provider sign-in, folder approvals, saved-session resumption and WhatsApp phone round trips on each supported platform.
- Signed/notarized release artifacts, public or approved accessible artifact hosting and installer endpoint deployment.

The macOS packaging recipe currently provides development ad-hoc signing only. The installer scripts do not remove quarantine or bypass execution policy. Speech tools and models require manual configuration in this shared preview; native Desktop chat injection and deep-link parity are not claimed.

## Integration handoff

This snapshot began at `98cb52e2dde6b04f20f839a68768d26d624b82e7` and has no Git metadata. The original checkout has advanced since then. Integrate changes against that base rather than copying the entire snapshot over the active source tree.

New implementation areas are `desktop/`, `install/`, `.github/workflows/desktop.yml`, desktop build/package/smoke scripts, and portable backend modules (`platform.ts`, `portable-native.ts`, `claude-sdk-session.ts`, `service-lock.ts`). Shared backend changes also touch configuration, server routes, startup/shutdown, power management, session adapters and master routing. Reconcile these with current native changes and retain its active state paths and session identities.

The main chat owns repository integration and release publication. Do not include `node_modules/`, `build/`, `desktop/build/`, `.dart_tool/`, local auth/state, or preview fixtures as production account data. Preserve the native Mac implementation until the shared app has passed its platform checks. The artifact workflow builds packages but does not publish them.

## Main repository integration in progress

The snapshot was reconciled against its original base on branch codex/shared-desktop, preserving later native/backend changes. The integrated app retains the Mac native transport, stable bundle identifier and legacy state directory. Other platforms use the portable adapter. Speech tools and model are now included in target build recipes. A crash-safe SQLite service lock replaces PID-file cleanup. Local backend suite passed 138 tests with one optional skip, TypeScript checks and Flutter analysis passed. Four hosted native builds plus isolated packaged-app startup checks are the next gate; these results do not yet establish real-phone or provider end-to-end behavior.

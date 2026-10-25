# FarFromDesk shared desktop implementation

## Decision and ownership

The user's current choice is an installed desktop app, bootstrapped by a shell command on macOS/Linux and PowerShell on Windows. Flutter 3.47.7 provides the shared desktop UI; the existing TypeScript backend retains WhatsApp, routing, durable state and request-bound permissions. Flutter does not require rewriting that backend in Dart. No Homebrew formula, Electron shell or separately maintained Linux/Windows UI is needed.

The shared desktop implementation is integrated in `LazyCodeer/farfromdesk`. Its source snapshot was reconciled against commit `98cb52e2dde6b04f20f839a68768d26d624b82e7`, preserving subsequent backend work. The repository and preview releases remain private.

## Layout

- `desktop/lib/app.dart`, `screens.dart` and `bridge_theme.dart`: shared Home, Activity, Settings and exact-session UI, matching the existing native design (see [Design parity](DESIGN-PARITY.md)).
- `desktop/lib/native_gateway.dart`: native file pickers, authenticated loopback calls, bundled backend launch, login startup.
- `desktop/lib/main.dart`: desktop window and close behavior.
- `desktop/lib/preview.dart`: sample-data preview only; never package as the native entry point.
- `src/platform.ts`: state paths, executable discovery and capability gate.
- `src/portable-native.ts`: public Codex catalog/read APIs and public Claude session metadata.
- `src/claude-sdk-session.ts`: public Agent SDK, exact resume identity, default native permissions.
- `src/service-lock.ts`: prevents two new backends from recovering the same store.
- `install/`: Unix and PowerShell installers.
- `script/prepare_desktop_backend.mjs`, `script/package_desktop.py`: backend staging, bundled Node runtime and native archives.
- `.github/workflows/desktop.yml`: four-target build, test, packaging and private-preview publication pipeline. Publication runs only on main after every target passes.

The older `macos/` Swift client and `native/` Mac transport are retained as integration inputs. The integrated Flutter app retains the existing Mac native adapter on macOS; Windows and Linux use the portable CLI adapter and do not advertise unverified Desktop delivery.

## Development

Install Flutter 3.47.7, a supported Node 22 release (minimum 22.13 for `node:sqlite`) and the native build tools:

- macOS: full Xcode, accepted license, CocoaPods where required by Flutter plugins.
- Windows: Visual Studio 2022 desktop C++ workload and Windows SDK.
- Linux x64: clang, CMake, Ninja, pkg-config, GTK 3 and development libraries (see CI).

Run from the repository root:

```sh
npm ci
npm run check
npm test
npm run desktop:backend
```

For native development, launch Flutter with **isolated state and port values** and absolute paths to this snapshot and the local Node executable. Do not start it against the active macOS bridge:

```sh
cd desktop
WSB_STATE_DIR=/absolute/private/ffd-dev-state WSB_PORT=47941 \
FFD_BACKEND_ROOT=/absolute/path/to/repository FFD_NODE_BIN=/absolute/path/to/node \
flutter run -d macos
```

Use `-d windows` or `-d linux` on those hosts. Native builds are required on the target OS.

For a **UI-only preview** with no account access or backend:

```sh
cd desktop
flutter run -d chrome -t lib/preview.dart
```

That browser preview is a development aid. Installers always launch the desktop entry point.

## Native packaging

On the target OS:

```sh
npm ci
npm run desktop:backend
cd desktop
flutter pub get
flutter analyze
flutter test
flutter build macos --release
```

Substitute `windows` or `linux` for the build target. Return to the repository root and run:

```sh
node script/smoke_desktop_backend.mjs
python3 script/package_desktop.py --version 0.7.0-preview.1
```

Use `python` on Windows. Outputs are in `build/desktop-release/`, with a platform/architecture filename and a matching `.sha256`. The current recipe targets macOS arm64/x64, Windows x64 and Linux glibc x64. Linux arm64, Windows arm64, Alpine/musl and arbitrary old OS versions are not supported by this preview.

The backend staging script installs production dependencies on that OS and copies its Node executable; users do not need to install Node. CI pins Node 22.20.0. The Mac packaging script uses ad-hoc signing only for development. Developer ID signing/notarization and Windows signing are separate release gates. The installers never remove quarantine or disable execution protections.

## Installer publication contract

Each published version must have:

```text
FarFromDesk-VERSION-macos-arm64.zip
FarFromDesk-VERSION-macos-x64.zip
FarFromDesk-VERSION-linux-x64.tar.gz
FarFromDesk-VERSION-windows-x64.zip
```

Each archive must have the same filename plus `.sha256`, containing its SHA-256 and basename. Mac archives contain `FarFromDesk.app`; Linux/Windows archives contain `FarFromDesk/` with the executable and backend.

Installer defaults refer to `LazyCodeer/farfromdesk` GitHub release `v0.7.0-preview.1`. This is a **publication contract, not a currently working download**. The repository is private; anonymous downloads fail until the owner provides an approved accessible distribution channel. A private HTTPS mirror can be passed through `FFD_RELEASE_BASE` (Unix) or `-ReleaseBase` (PowerShell). Do not embed tokens in scripts or published commands.

Once the website owner publishes these scripts and matching artifacts, the intended command shape is:

```sh
curl -fsSL https://ffd.codecylabs.com/install.sh | sh
```

Windows PowerShell command shape:

```powershell
Invoke-WebRequest https://ffd.codecylabs.com/install.ps1 -OutFile "$env:TEMP\farfromdesk-install.ps1"
& "$env:TEMP\farfromdesk-install.ps1"
```

These website endpoints have **not** been deployed by this chat. PowerShell execution policy stays intact; organizations that disallow scripts must use an approved signed script or the release archive. Source scripts can be inspected before running. Unix supports `FFD_NO_LAUNCH=1` and `FFD_DRY_RUN=1`; Windows supports `-NoLaunch` and `-DryRun`.

Install locations are user-local: `~/Applications/FarFromDesk.app`, `~/.local/opt/farfromdesk/VERSION`, and `%LOCALAPPDATA%\Programs\FarFromDesk\VERSION`. Linux gets an application-menu entry; Windows gets a Start shortcut. Installing does not enable forwarding or login startup. Those choices belong to Settings. The Mac installer keeps a timestamped prior app backup; Linux/Windows keep prior version folders.

To uninstall, turn off startup and forwarding in Settings, close the app, then remove its installed app/version directory and application-menu shortcut. Account state is retained until the user deliberately removes it. The installers do not delete request history or provider state.

## State, permissions and lifecycle

- macOS retains `~/Library/Application Support/WhatsApp Session Bridge` for compatibility; Windows uses LocalAppData/FarFromDesk and Linux XDG_DATA_HOME/farfromdesk.
- The renderer receives no long-lived credentials in a URL. Native Dart reads the private local token and uses authenticated loopback requests. No browser dashboard is exposed.
- App close leaves the backend running only when forwarding is enabled. When forwarding is paused, close requests a graceful backend shutdown. No service is installed as root/SYSTEM.
- Login startup uses the user's platform startup registration through `launch_at_startup`. An explicit `--enable-login-startup` launch argument can preserve an already-authorized startup preference during migration; ordinary launches never enable it. OS approval errors remain visible.
- Idle-sleep prevention uses caffeinate, a Windows power assertion, or systemd-inhibit. Failures are surfaced in Settings. Display locking and logout policies remain with the OS.
- The old Mac client must not run concurrently during migration. The new UI refuses to attach to a backend lacking the expected health protocol rather than killing or replacing it.
- CLI resumption requires the user to finish a currently running native turn first. Public history metadata is not a universal cross-process lock. Windows/Linux Desktop injection is not claimed; the existing Mac native adapter is retained.
- Existing permissions are not silently widened. Codex defaults to read-only for resumed unmanaged conversations; bridge-created workers use their explicitly approved workspace. Claude uses `default` permissions and user/project/local settings, with permission requests routed through existing request-bound approvals.
- The integrated packages build and include FFmpeg, whisper.cpp and the multilingual base model for each target. Their manifest and hashes are verified at startup; existing valid custom settings are preserved.

## Verification and remaining release gates

See [Desktop validation](DESKTOP-VALIDATION.md) for evidence and remaining limits. Every target runs TypeScript checks, portable regressions, Flutter analysis/widget tests, native compilation, bundled speech tests, packaging integrity checks and real packaged GUI startup with isolated state. Mac runners also run the full backend suite. Windows validates its PowerShell installer; Unix runners execute installer fixture tests.

Pushes to main build all four targets and publish one private prerelease only when all succeed. Version suffixes use the GitHub run ID. Each release includes six app archives, six checksums, four provenance manifests and two version-stamped installers. The publisher checks exact source commit, all four platforms, asset hashes and repository privacy before publication. PR and feature-branch builds do not publish.

This host lacks full Xcode, so Mac native compilation uses GitHub-hosted runners. Signing/notarization credentials, real-phone/provider account verification on each OS and public installer hosting remain separate gates. CI never receives pairing or provider-account credentials.

## References

- [Flutter desktop support](https://docs.flutter.dev/platform-integration/desktop)
- [OpenAI app-server protocol](https://developers.openai.com/codex/app-server)
- [OpenAI Windows sandbox](https://developers.openai.com/codex/windows)
- [Official Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Dart native process launch](https://api.dart.dev/dart-io/Process/start.html)

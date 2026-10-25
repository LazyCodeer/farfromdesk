# FarFromDesk Mac app

The native app is built with SwiftUI and targets macOS 14+. Release packaging supports Apple Silicon and Intel variants; the default local development build targets Apple Silicon. Intel hardware verification remains pending.

## Build and install

Follow the prerequisites in [development guide](docs/DEVELOPMENT.md), then run:

```sh
npm ci
./script/build_and_run.sh --build-only
./script/install_macos.sh
```

For an update, use `./script/install_macos.sh --replace`. The current app is backed up before replacement. Build scripts produce an ad-hoc signed development bundle, not a notarized public installer.

## App structure

- **Home:** WhatsApp connection, reply destination, current master and platform selection, voice readiness.
- **Activity:** Request lifecycle, delivery failures and recovery/review actions.
- **Settings:** Coding app enablement, login/background preferences, optional keep-awake behavior and app information.

The app reads durable service state rather than assuming a UI action completed a native request. Group discovery is cached; the explicit Refresh groups action refreshes it. Selecting Message yourself hides group configuration.

## Compatibility across the rename

The displayed name is FarFromDesk. `Session Bridge.app`, executable `SessionBridge`, bundle ID `app.sessionbridge.mac`, launchd service labels, and `~/Library/Application Support/WhatsApp Session Bridge` remain stable. Legacy `Tether Projects` workspace and `.tether-*` startup receipts also remain stable so previously approved workspaces and recoverable operations keep working. Existing user-created native session and WhatsApp group names are not changed.

The UI installer does not restart an existing background bridge. Source changes to the backend require an intentional service reload after checking active requests. Updating the UI alone does not install new behavior into an already-running Node process.

## Permissions and availability

Background operation uses a launchd agent. Login/background consent and coding-app native permissions still apply. Keep-awake uses an idle-sleep assertion; it does not bypass the lock screen, manual sleep, low battery shutdown, or unsupported lid-close behavior.

## Verification

Run `./script/test_macos.sh` for native tests. See [Testing](docs/TESTING.md) for preview rendering and opt-in live checks. Inspect the release checklist before distributing a binary.

# Developing Sidekick

## Build from source

### Requirements

- Apple Silicon Mac running macOS 14 or later for the bundled app/speech build.
- Xcode or Command Line Tools with a Swift 6 toolchain.
- Node.js **22.13+** and npm.
- Python **3.12+**, CMake, and the standard macOS build tools.
- A supported coding app/runtime, signed in with an eligible account.
- Internet access for initial dependency, speech source, and model downloads.

```sh
git clone https://github.com/LazyCodeer/sidekick.git
cd sidekick
npm ci
npm run check
npm test
./script/test_macos.sh
./script/build_and_run.sh --build-only
./script/install_macos.sh
```

Access to the private repository is required. Use `./script/install_macos.sh --replace` when updating an existing local installation. The installer backs up the previous app.

The app displays **Sidekick**. Its bundle filename remains `Session Bridge.app`, and its executable, service identifiers, and state directory retain their original names for migration compatibility. Existing pairings and stored requests are not renamed or discarded.

The build prepares pinned FFmpeg/whisper.cpp sources and a checksum-verified multilingual base model, then bundles them for local transcription. Model downloads occur during the build, not when you send a voice note. The current package is ad-hoc signed for local development, not Developer ID signed or notarized. Do not disable macOS security controls to run an untrusted build.

The app can initialize its bundled background service. Existing developer installations are reused. Advanced CLI setup and native hook installation are documented in [the technical guide](reference.md).

## Development and verification

```sh
npm run check                 # TypeScript checks
npm test                      # Backend unit/integration suite
./script/test_macos.sh         # Native contract and UI-state tests
npm run build                 # Compile the bridge
```

The normal suite uses controlled fixtures. Local speech and live-service checks are explicitly opt-in; see [Testing](TESTING.md). A green test suite is not proof that a phone message completed a real native action. Validate the chosen account, app version, hooks, delivery, and correlated reply before relying on remote control.

| Directory | Responsibility |
| --- | --- |
| `macos/` | SwiftUI app, platform discovery, setup and request UI |
| `src/` | WhatsApp transport, routing, queue, approvals, media and native adapters |
| `native/` | Vendored native desktop delivery helpers |
| `skills/` | Agent instructions for scoped replies and attachments |
| `test/` | Backend tests and synthetic audio fixture |
| `script/` | Build, install, packaging and diagnostic tools |
| `docs/` | Architecture, testing, troubleshooting and release guidance |


See [Contributing](../CONTRIBUTING.md) and [Testing](TESTING.md).

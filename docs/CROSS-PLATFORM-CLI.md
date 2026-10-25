> Superseded implementation decision, 25 October 2026: the user chose a **Flutter desktop app**, installed by shell/PowerShell commands. The browser UI below was a feasibility proposal; the shipped target is now desktop. See [Desktop development](DESKTOP-DEVELOPMENT.md).

# Shared Sidekick CLI and browser UI: feasibility

Assessed 25 October 2026 against committed source `98cb52e2dde6b04f20f839a68768d26d624b82e7`. This is a private, local design assessment, not an implemented or released cross-platform installer. The macOS source checkout and running service were not changed.

## Recommendation

Use one TypeScript backend, one browser UI, and a CLI entry point. Retain the macOS app as an optional client of the same backend. Do not build separate Windows and Linux desktop applications. The eventual implementation belongs in the same Sidekick repository; this sibling directory is an isolated working snapshot, not a new product or published fork.

The proposed user command is `sidekick setup`: register a per-user background service, start it, print a loopback URL and open the browser. The user enables forwarding, pairs WhatsApp, and chooses the exact coordinating session there. `sidekick open`, `status`, `stop`, `start`, `doctor`, and `uninstall` provide a consistent interface. These command names describe proposed behavior; the current CLI does not implement this flow.

## Evidence in the current code

- `src/server.ts` already exposes authenticated HTTP endpoints for QR pairing, destination selection, provider discovery, master selection/creation/recovery, request history, approvals, local voice configuration and reviewed documents.
- The browser routes currently return HTTP 410. A browser UI must be implemented; the SwiftUI screens cannot simply be served as HTML.
- `src/cli.ts` already contains status, session, reply and service commands, but service installation and app opening are macOS-only. A top-level `process.getuid()` call also prevents this CLI from starting on Windows.
- `src/config.ts` hardcodes a macOS state location; `src/power.ts` uses `caffeinate`; `src/native.ts` reads a specific Codex SQLite schema and invokes the macOS desktop helper. These need platform abstractions.
- WhatsApp account/destination checks, durable SQLite request state, coordinator routing, approval handling and bounded local speech/document processing are reusable logic.

## What is shared and what varies

| Component | Approach |
| --- | --- |
| Home, Activity, Settings, pairing and setup | One browser UI and HTTP API |
| CLI commands, request storage, routing and recovery | One backend |
| macOS background registration | User LaunchAgent; Homebrew service integration can use the same executable |
| Linux background registration | `systemd --user` on supported desktops; foreground mode when no user service manager is available |
| Windows background registration | Per-user scheduled task at logon, running as the signed-in user; separately test lifecycle and logout behavior |
| Data paths and executable discovery | Small OS adapters, including Windows npm launcher handling |
| Keep awake | OS adapters with honest availability; never disable screen locking |
| Local speech | Shared orchestration; FFmpeg/whisper binaries per OS and CPU, model acquired separately or bundled under reviewed terms |
| Agent integration | Supported CLI protocols first; desktop delivery gated by verified platform capabilities |

Closing the browser must not stop the service. A per-user service is not a promise to work after logout or while the machine sleeps. Unsupported OS/service-manager combinations need an explicit foreground fallback.

## Assistant compatibility is a separate gate

OpenAI documents a stdio app-server protocol with `thread/list`, `thread/read`, `thread/resume`, approval requests and exact thread IDs. This is preferable to assuming the macOS private queue/socket transport or SQLite schema is portable. Use the documented default stdio transport or `--listen stdio://`; the current `--stdio` argument needs compatibility review.

Anthropic's official Agent SDK package exposes session listing, exact-session resume and `canUseTool` callbacks with the `default` permission mode. Its published TypeScript definitions were inspected during this assessment. Actual native Windows/Linux authentication, folder permissions and session behavior still require runtime tests. The documentation website returned HTTP 403 from this environment, so no claim is made that the full setup documentation was verified.

Resuming a saved CLI session is different from injecting a message into an already-running Desktop conversation. A browser UI does not remove that distinction. Preserve exact session ID and project path, refuse unsupported desktop delivery, and do not run concurrent writers against the same session. Do not copy provider credentials or rewrite native trust settings.

## Install and distribution

- macOS: Homebrew formula, optionally a downloadable bundle. Keep the native app as another installation option.
- Linux: a versioned shell installer or downloaded archive for supported distributions/architectures.
- Windows: a PowerShell installer or downloaded archive; WinGet can follow once distribution/publication is approved.
- `curl -fsSL` is the Unix command pattern the user described. A shell installer does not run universally on native Windows; PowerShell requires its own small bootstrap.
- Installers should fetch versioned platform archives, verify recorded checksums and install into a user-owned directory. Bundle a pinned supported Node runtime so users need not manage Node themselves. A runtime and media binaries require platform-specific artifacts, not separate application codebases.
- The repository is private. Do not advertise an anonymous download URL, Homebrew tap, npm package or WinGet package until the exact private/public distribution arrangement is approved. No endpoints or packages have been published.

## Browser authentication and coexisting clients

Keep the server on loopback with Host/Origin validation. Open the UI through a short-lived, one-use launch credential and exchange it for a scoped browser session; do not put the permanent administrator bearer token into URLs, logs or browser storage. Preserve binding-scoped agent tokens. Static assets must never include credentials or private runtime files.

The macOS app and CLI should discover and share one version-compatible backend/state directory, with an explicit migration and single-instance policy. Installing the CLI must not silently register a second WhatsApp connection. The new implementation must be developed with isolated state and port values until integration is deliberate.

## Validation still required

Backend unit/type checks are available on this Mac. Required later: browser integration tests; service install/start/stop/uninstall on all supported OS targets; actual provider sign-in/permission/exact-session tests; real-phone pairing/reconnect, voice, documents and restart recovery. No Windows or Linux runtime verification or build is claimed by this assessment.

## Sources

- [OpenAI app-server](https://developers.openai.com/codex/app-server): supported transport, session and approval protocol.
- [OpenAI Windows documentation](https://developers.openai.com/codex/windows): native Windows and sandbox requirements.
- [Official Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript): supported programmatic integration; inspected package version 0.3.310 during research, not selected as a production dependency.
- [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook): formula and service definitions.
- [systemd service reference](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html): service lifecycle behavior.
- [Node supported platforms](https://github.com/nodejs/node/blob/main/BUILDING.md): platform-specific runtimes; final supported OS minimums must be pinned to the chosen Node release.

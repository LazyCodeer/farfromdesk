# Content evidence

Reviewed 25 October 2026 against the local FarFromDesk product source. Product files were read only; this website work did not build, restart or modify the app.

| Website claim | Product source reviewed | Limits preserved |
| --- | --- | --- |
| Home, Activity, Settings; pairing, reply destination, master and voice readiness | Native `ContentView.swift`, `WhatsAppView.swift`, `MasterSetupView.swift`, `BridgeComponents.swift` | Website illustrations contain sample content and are not native screenshots |
| Three setup steps | Native pairing, destination and master setup; `README.md` | Native account access, background consent and integration requirements still apply |
| Selected-session coordination | `README.md`, `MASTER.md` and native master setup | Only chosen sessions; original context and permissions remain |
| Codex/Claude, Desktop/CLI differences | Native master picker, `docs/native-workspace-validation.md`, `docs/test-plan.md` | Discovery is not proof of a reachable session or model access; Claude Desktop creation is conditional |
| Local voice transcription | `README.md`, `MAC-APP.md` bundled speech section | WhatsApp transports audio, coding provider receives transcript, typed approvals required |
| Mac availability and optional idle-sleep prevention | `MAC-APP.md` | No blanket closed-lid support |
| Current distribution | `MAC-APP.md` release gates and bundled speech section | Local arm64/macOS 14+ preview; signed/notarized public download unverified |

The native source takes precedence over older descriptive sections in product documents. The website deliberately avoids installed build numbers, private session names, real phone numbers, performance claims, testimonials, security certifications and promises of universal support.

No public app repository or public installer was found during the GitHub inventory check. The company website repository was private. No app package has been copied into this repository.

The social sharing PNG is derived from a browser capture of this website's illustrated hero, with no private app data. Font and icon license notices ship in `public/fonts` and `public/licenses`.

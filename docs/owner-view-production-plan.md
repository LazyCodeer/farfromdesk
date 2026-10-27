# FarFromDesk Remote Desktop: production integration plan

Prepared 27 October 2026. Planning/research only; no production build, installation,
network deployment, account setup or purchases performed.

## Decision

Build Remote Desktop inside the existing Flutter FarFromDesk app. Use LiveKit's
Flutter and browser SDKs as the first transport candidate, and retain the pinned
MIT Cua Driver for supported native inspection/control. Prove capture/input
integration in a signed app spike before committing the dependency architecture.
All user setup, permissions status, pairing, session start, diagnostics and Stop
must be available in the app. No Terminal, PID entry, localhost-code copying,
manual helper launch or user-run server. macOS consent remains in System Settings
or system dialogs, which the app opens when the user requests it.

This is component reuse, not a ready-made drop-in FarFromDesk remote desktop.
Identity, input scoping, owner authorization and lifecycle remain our work.

## Sources and reuse assessment

Reviewed upstream README/license sources on 27 October 2026. Pin exact versions,
checksums and all transitive notices during implementation; upstream main can change.

| Candidate | Verified upstream facts | Fit / decision |
| --- | --- | --- |
| [LiveKit](https://github.com/livekit/livekit), [Flutter SDK](https://github.com/livekit/client-sdk-flutter), [browser SDK](https://github.com/livekit/client-sdk-js) | Apache-2.0; Flutter screen sharing and desktop screen/window selection documented; WebRTC media and data | Recommended transport spike. Reuse session connectivity, stream rendering and diagnostics. Requires a service, host authorization and native input integration. |
| [Flutter WebRTC](https://github.com/flutter-webrtc/flutter-webrtc) | MIT; README lists macOS screen capture and data channels | LiveKit Flutter already uses it. Direct use is fallback for a lean peer-to-peer design, but we then own signaling, reconnect and more diagnostics. |
| [Cua Driver](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md) | MIT base driver; embedded mode requires grant-owning app to parent private daemon | Retain for supported inspection/actions; test generated embedded-host API against pinned version. Not a complete phone/video product. |
| [RustDesk](https://github.com/rustdesk/rustdesk) | Full remote-desktop product; Flutter UI; Rust capture/input services; AGPL-3.0 | Strong reference and alternative if adopting a larger product/fork is desired. Embedding/distribution entails AGPL obligations; do not describe it as permissive drop-in code. |
| [noVNC](https://github.com/novnc/noVNC) | Browser VNC client; core MPL-2.0, other asset licenses | Solves browser rendering/input protocol, not Mac capture or server. Needs VNC server and WebSocket/auth infrastructure; not the cleanest fit for our app-owned grants. |
| [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop) | Apache-2.0; model-driven GUI agents, screenshots/local and remote operators | Useful agent reference. Does not by itself implement our owner-authenticated phone remote-control product. |
| [Cua Spaces daemon](https://github.com/trycua/cua/blob/main/libs/cua-spacesd/README.md) | ScreenCaptureKit/VideoToolbox macOS streaming; README identifies FSL-1.1-MIT and macOS 26 SDK requirement | Not covered by the repository's MIT headline. Exclude from default reuse until its separate terms and compatibility are accepted. |
| [coturn](https://github.com/coturn/coturn) | STUN/TURN server, BSD-style three-clause license, time-limited credentials | Option for direct-WebRTC fallback. Don't add a duplicate TURN deployment if selected LiveKit hosting already provides it. |

Upstream support is documentation evidence, not proof it works in this app. No
candidate server or SDK was installed or benchmarked during this research.

## User journey

1. Open FarFromDesk > Remote Desktop. Separate rows show Accessibility and Screen
   Recording: Allowed / Needed / Needs restart / Unable to check. Include refresh
   time, exact responsible app identity and a useful error. Check updates the rows;
   it must not imply a viewer was started.
2. A first-run wizard opens native settings, explains exactly which app to enable,
   then rechecks the real capture/input process. A built-in harmless text/button
   test verifies end-to-end operation and displays the result in FarFromDesk.
3. Choose a window or display, preview it locally, and choose View only or Allow
   my input. Show a clear scope indicator. Window mode does not promise to capture
   separate popup windows. Display mode can show ordinary popups on that display.
4. Pair a phone in the app, using a one-time QR/device confirmation flow. Store its
   public identity; keep private keys in platform secure storage. Initial pairing
   requires app confirmation, not copied Terminal secrets.
5. Telegram's Open my Mac button opens an authenticated phone view. The link is
   only a rendezvous reference, not a permanent bearer credential. A previously
   paired device can request a bounded session under the owner's explicit access
   policy. Unpaired clients require fresh app approval; no unnoticed unattended mode.
6. Phone view provides video, display picker, touch-to-click, drag/scroll, text input,
   keyboard controls, connection status and Stop. Mac app/menu bar shows who is
   connected, selected scope, remaining time and immediate Stop. Ended sessions
   show a readable ended/reconnect page instead of a dead localhost link.

## Architecture

Mac Flutter app <-> signed native capture/control host
Mac app <-> authenticated session service <-> phone browser
Mac app <-> LiveKit media/data transport <-> phone browser
Existing Telegram bridge supplies owner-validated launch requests, not raw input.

- Extend desktop/lib/mac_control_panel.dart into a dedicated Remote Desktop view;
  connect app/gateway status and commands instead of invoking owner-view/main.ts.
- Manage embedded helper lifetime from the grant-owning native app. Prefer the
  supported embedded host and typed native/Flutter boundary. Production must not
  depend on the test FIFO launcher, private Terminal, or temp executable paths.
- Keep transport/session privileges separate from bridge administration and agent
  APIs. Never expose the existing localhost bridge/admin port to the internet.
- Reuse mature SDK capture first. If window/display scope or metadata is inadequate,
  add a thin ScreenCaptureKit integration; do not build a new codec/network stack.
- Video transport is not an input engine. Cua capture IDs refer to particular
  screenshots; they cannot simply be reused against arbitrary live-video frames.
  The spike must prove either a supported current Cua scoped input path or a thin
  native manual-input adapter. Preserve observe/act restrictions for agents.
- Each manual input includes session ID, unique sequence/action ID, scope generation,
  displayed frame timestamp and transform. Map letterboxed video to physical
  display/window coordinates, handle Retina scaling, negative monitor origins and
  topology changes. Reject stale geometry. Never silently retarget another window.
- Order pointer down/up and keys; coalesce obsolete pointer moves. Do not replay
  clicks/text after reconnect or unknown outcomes. Release held keys/buttons on
  disconnect/Stop. App verification must distinguish delivered from observed effect.
- Support text insertion/Unicode/IME separately from key chords; do not use the
  current observed-field dropdown as the final human remote-desktop UI. Do not
  enable clipboard synchronization or file transfer implicitly.
- Native process state checks gate input/capture. Runtime state machine: Off,
  Needs permission, Ready, Pairing, Connecting, Viewing, Controlling, Disconnected,
  Locked, Sleeping/Unavailable, Stopped, Error. Reason and recovery appear in-app.

## Network/authentication choice

Recommended product path: authenticated HTTPS session service plus LiveKit
(self-hosted or managed, selection pending). Mac connects outbound; no router port
forwarding or shell setup. TURN handles networks where a direct route fails.
A private VPN is useful for engineering validation but should not be the default
consumer onboarding requirement.

Validate Telegram origin/owner server-side when applicable, bind to a paired
browser/device identity, and issue short-lived scoped media/control grants. A
copied Telegram URL alone must not grant control. For external-browser handoff,
explicitly test the identity transfer; do not assume Telegram WebApp identity is
available in every browser. Passkeys/device keys are a candidate, not implemented.

Require authenticated key exchange, media E2EE and encrypted authenticated control
payloads if the relay must not read contents. Do not assume default transport TLS
or an SDK E2EE switch encrypts every data/control path. Verify chosen Flutter and
Safari/browser SDK combinations, key distribution, relay visibility and revocation.
No pixels, typed values, private keys or reusable credentials in routine logs.
Metadata-only diagnostics should still explain failures and connection phases.

A hosting/domain/operations decision and any spend approval are needed before
remote deployment. None is needed to build the local in-app spike.

## Scope and limitations

First production candidate: owner-operated unlocked Mac, one selected window or
one display at a time, two-monitor selection, explicit input enable, visible Stop.
No lock-screen bypass, password entry through a bot, native permission approval,
full-control guarantee over security dialogs, automatic wake/offline replay, or
agent inheritance of owner remote-control authority. Sleep/lock/offline are distinct
states. Unknown state fails closed. Protected native prompts may require local action.

Window capture must explain popup exclusions; display capture is a broader explicit
choice. Human viewing/control and model interpretation have different boundaries.
Meta explanations remain optional and require specific content-sharing consent;
no model should sit on the latency-critical path of an ordinary human click.

## Delivery stages and gates

1. **In-app local integration.** Ship wizard/status/safe test/preview/Start/Stop in
   a separately signed test channel. Bundle probe and dependencies. No Terminal.
   Gate: cold launch, grant denial/grant/revocation, restart and app update tested
   against the actual responsible process. Preserve stable test vs production IDs.
2. **Transport spike.** Integrate pinned LiveKit Flutter/browser SDKs with selected
   screen/window capture; demonstrate phone Safari and Android Chrome video and
   scoped manual input. Validate E2EE and TURN fallback in the chosen deployment.
   Gate: real phone-to-Mac result, no copied secrets, no bridge port exposure.
3. **Control/lifecycle reliability.** Test clicks, typing, drag, scroll, key release,
   ordinary popups, selected-display switching, resizing, Retina/mixed DPI, negative
   coordinates and Spaces. Snapshot-age protocol must work with streaming. Gate:
   no wrong-target input; unknown result stops, no duplicate replay.
4. **App-owned phone pairing and operations.** Pair/revoke devices in app, Telegram
   launch, single active controller, view-only mode, visible status and Stop, rate
   limits, disconnect/reconnect with fresh authorization. Gate: copied/expired
   links and unpaired browsers cannot view or control; relay cannot authorize input.
5. **Release hardening.** Developer ID signing/notarization, nested helper signatures,
   update/rollback, clean-Mac onboarding, permission attribution after update, crash
   cleanup, CPU/memory/network measurements and signed staged rollout. Gate: full
   in-app workflow on clean install, no Terminal, no production bridge regression.

Measure p50/p95 time to first frame and input-to-visible-result on LAN, mobile data
and forced relay. Tentative targets to evaluate, not promises: first frame within
five seconds on a healthy connection; p95 visible response under 300 ms on LAN
and under 700 ms over mobile/relay. Prefer adaptive 15-30 fps over JPEG polling;
measure text clarity, bandwidth, power and unsupported network behavior.

## Existing work to retain and gaps

Retain session expiry, single-use pairing principles, scoped input, action IDs,
Stop and the tested native permission chain. The live prototype demonstrated a
fixture screenshot, typed-text readback, one increment click, duplicate/stale-frame
rejection and Stop. It did not validate phone networking, arbitrary applications,
streaming alignment or end-to-end browser interaction. Pure local expiry tests do
not establish live lock/sleep/revocation behavior.

Retire user-facing terminal launch and five-second manual-refresh interaction.
Fix status/reconnect UX, signed lifecycle and tested native process ownership.
The safe fixture exception for incomplete AX trees is not a general permission
or production escape hatch. Manual display input requires its own designed scope.

Next concrete implementation: in-app local integration plus a bounded LiveKit
capture/input spike. Produce a signed test build and measured evidence before
choosing infrastructure and promoting anything to production.

# Native validation follow-up and phone setup decision

## Production/test correction

The owner correctly identified the opened application as production. Reading its bundle metadata confirmed `~/Applications/FarFromDesk.app` is **FarFromDesk**, bundle ID `app.sessionbridge.mac`. The permission check used that application's bundled `FarFromDesk Accessibility.app`, bundle ID `com.codecylabs.farfromdesk.accessibility`, executable `Contents/MacOS/ffd-accessibility`. This was not a separately packaged Owner View test helper. **The earlier recommendation to change that helper's Accessibility entry is withdrawn for this isolated viewer test.** Preserve production and its existing grants.

The actual Owner View artifact is `src/owner-view` / compiled `dist/owner-view`, a local browser UI and a separate Node listener. There is no separately packaged Owner View test app yet. `script/owner_view_preview.mjs` now opens the real viewer assets in an explicitly disconnected **Owner View Test · Setup only** state. All capture/input/pairing buttons are disabled, there is no native driver or messaging client, and all action requests are refused. The listener binds an ephemeral loopback port and expires after 15 minutes. It can be launched with `node script/owner_view_preview.mjs` after `npm run build`.

For request 320 the preview was served at `http://127.0.0.1:54798` and opened with macOS `open -a Google Chrome`. HTTP inspection verified the correct setup-only header and production warning. This URL is temporary and local to the Mac, not a phone link. No live screen was captured and no permission was requested. Browser launch success and served HTML are distinct from a screenshot-based visual verification.

The remaining implementation prerequisite is a separately named and separately identified, locally built Owner View test host/helper bundle, with its own native permission flow and visible Stop. Do not point the isolated viewer back at the production helper to work around missing permission. Only after that artifact exists should the owner be directed to its exact native permission entry and the live safe-window trial resumed. Nothing in production was replaced, quit, reinstalled or reconfigured; no private state was copied and no second messaging client was started.

## Owner-unlocked continuation

After the owner's explicit unlock confirmation, the native probe returned `UNLOCKED`. A read-only check through the installed helper then reported Accessibility **false**, Screen Recording **true**, and host identity `com.codecylabs.farfromdesk.accessibility`. The reproducible preflight exited 2 and saved sanitized evidence in `evidence/owner-view/unlocked-preflight.json`. No screenshot, click, typing or permission request was performed. The owned driver was stopped. This supersedes the earlier live `SESSION_LOCKED` blocker; it does not invalidate the earlier observation.

Exact owner action: in macOS **System Settings → Privacy & Security → Accessibility**, grant the entry for **FarFromDesk Accessibility** if it appears. The helper inspected for this local test is inside `~/Applications/FarFromDesk.app/Contents/Resources/backend/native/FarFromDesk Accessibility.app`. If no entry appears, add that exact helper with the + control or have its normal permission request presented, then approve it yourself. Do not remove/reset the existing FarFromDesk grant or grant a similarly named unrelated app. This is a separate local test process; the result does not assert that the main running FarFromDesk app lacks its own grant. Screen Recording was already true for this check.

Re-run `node script/owner_view_preflight.mjs /tmp/ffd-owner-session-state /absolute/path/to/backend/native` after the owner grants permission. A zero result is only readiness, not a passed control trial. Only then open/select the safe fixture and test capture, click, typing and native Stop. Expiry and Stop continue to be tested at the HTTP/session layer with a fake native backend; an additional real-time listener test verifies it expires and stops that backend without another request. These do not prove real OS input or Stop cancellation.

The owner's unlock confirmation did not authorize Tailscale or deployment. No transport configuration, Meta service, purchase or public endpoint was changed.

## Completed changes and actual evidence

- Fixed a probe interpretation bug: `CGSSessionScreenIsLocked` is absent on unlocked sessions, as documented in the inspected upstream Cua macOS `session.rs`. Absence is accepted only with a valid session dictionary, completed login, active console and `SessionGetInfo` graphical access. Missing session, non-GUI caller, malformed values and actual lock fail closed.
- Compiled the Swift probe and passed nine pure evaluation cases, including absent/true/false/numeric/malformed flags, missing session, no graphical access, inactive console and incomplete login.
- Live probe now returns `SESSION_LOCKED`. This is distinct from the earlier inconclusive result. No screenshot or input was attempted after that result. Unlock/relock and sleep transitions have not been tested.
- Improved native readiness diagnostics to distinguish session state, permission flags and unavailable app/window. No native stderr, typed input or credentials are returned to the owner.
- Fixed typing selection: the viewer now lets the owner select one observed editable field. It no longer relies on a presumed `focused` element property. The opaque native token stays server-side.
- Ten focused TypeScript tests pass, covering cookie/origin boundaries, expiry, revocation, uncertain actions, Stop, coordinate/text checks, normalized image coordinates (including a negative-coordinate desktop target), sensitive-window refusal, temporary screenshot cleanup, private field-token handling and simulated Meta requests. The native adapter tests use an injected fake driver, not live macOS input.
- The source checkout has no prepared native driver executable. The installed app at `~/Applications/FarFromDesk.app` does contain its helper and pinned Cua binary. The launcher can accept an explicit native resource directory for a controlled local test, but sharing executable files does **not** transfer the installed app's permission grants to a development process. Native checks must pass under the actual parent process.

The exact next owner action is to **unlock the Mac locally and leave its normal desktop awake** for the safe-window trial. Do not enter the password into Telegram or the viewer. After unlocking, re-run the probe before native startup. If the actual process lacks Accessibility or Screen Recording, report the named entry macOS requests and have the owner grant it. Do not infer missing permission from the lock result.

## Private phone connection recommendation

**Use Tailscale on the owner's phone and Mac, with private Tailscale Serve HTTPS for the owner-view listener. Do not use Funnel.** This is a recommendation, not deployed configuration. No `tailscale` executable or application was found in the usual checked locations; account/device membership was not inspected.

Architecture:

1. The existing Telegram connection receives the owner's visual-assistance request through outbound Bot API polling. Keep this mechanism and the current bridge admin API private.
2. The Mac app requires local feature opt-in and starts a single, revocable, five-minute selected-window session only while unlocked and correctly permitted.
3. A dedicated owner-view listener remains on loopback. Tailscale Serve terminates HTTPS on a private tailnet hostname. The tailnet ACL allows only the owner's phone identity/device to this view, not general access to the bridge.
4. Telegram returns a non-secret HTTPS URL and a separate single-use pairing code through the existing authenticated owner route. The code is not an authentication substitute for the private network. Session creation remains bound to the verified Telegram owner and local app approval.
5. The browser exchanges the code for a Secure, HttpOnly, SameSite cookie. Enforce the configured HTTPS origin/host; do not trust arbitrary forwarded headers. No screenshots or control endpoints accept the bridge's agent token or admin token.
6. The phone's explicit clicks and text become manual actions, never model calls. Expiry, Stop, lock, permission loss, network loss and app shutdown revoke the session; uncertain actions are not replayed after reconnect.

**Necessary integration still outstanding:** the current loopback prototype rejects a remote Host/Origin and uses a localhost cookie. Add a narrow configured public origin and Secure cookies only after the private deployment choice is approved, with reverse-proxy tests. Add app-owned lifecycle monitoring, Telegram owner binding/session issuance, visible local Stop and disconnect invalidation. Do not simply forward the current local listener unchanged. Do not expose the raw driver socket or bridge port. Tailscale Serve must be verified private with restrictive ACLs, followed by tests from the actual phone, including an unauthorized device and expired/revoked code.

Prerequisites/decision: owner agrees to install/sign in to Tailscale on both devices (or supplies an already configured private network), chooses the authorized phone identity, and approves private Serve configuration. No purchase, public hosting, router port forwarding or tunnel setup was performed. If installing a private network app is unacceptable, a separately reviewed authenticated HTTPS relay is the alternative and requires its own deployment/account decision.

## Exact Meta setup still missing

Normal project documentation has Telegram outbound polling but no configured Meta integration or remote relay. The three expected process settings `FFD_META_ENDPOINT`, `FFD_META_MODEL`, `FFD_META_KEY` are absent in this execution context. Only presence booleans were checked; no private app state or secrets were read. This does not establish the configuration of every other process.

Eligible choices to confirm against the official event track:

- Participant-provided Meta Model API access to a model eligible for the event, with its documented protocol. If it is not OpenAI chat-completions compatible, add the correct adapter rather than changing providers silently.
- An event-eligible Meta open-weight model hosted at an explicitly approved inference provider, or on the Mac if sufficient resources exist. The current contribution consumes visible labels/roles as text; vision-model deployment is not necessary for that first workflow explanation.

Needed locally: selected eligible model identifier, official base endpoint/protocol, working credential or local service, and consent to share bounded selected-window labels with that service. Do not paste keys into chat. Confirm participant/track eligibility, then run an actual model request, verify the returned model/provider identity, and evaluate suggestions on safe workflow fixtures. Current tests use a simulated service and establish neither live access nor hackathon eligibility. No credit claims, model downloads, subscriptions or network deployment occurred.

## Remaining live acceptance

Unlock locally; verify the real host's grants; open a harmless scratch fixture; select one exact window; capture; perform one click; refresh and verify; type into the explicitly chosen field; refresh and verify; exercise expiry and Stop. Preserve all existing app content. Then separately test native lock/relock and permission revocation with the owner, without automation of security prompts. Sleeping/offline machines cannot provide a live desktop and must never accumulate queued input. Actual phone transport and Meta inference follow only after their setup decisions.


## Isolated helper, 27 October continuation

Built and opened `build/owner-view-test/native/FarFromDesk Owner View Test.app`.
Bundle identity: `com.codecylabs.farfromdesk.ownerviewtest`. This is an AppKit
permissions setup UI, not a second messaging app. Normal launch shows setup;
`--server` retains the native driver protocol and `--diagnostic` permits read-only
status. Permission request buttons are owner-operated. Closing setup does not
claim to stop an independently started viewer; the viewer has its own Stop.

Build: `python3 script/build_owner_view_helper.py`. The build uses existing helper
source plus test-only setup code, signs a distinct bundle and verifies pinned Cua
0.38.0 bytes/signature. A stalled download was cancelled; the existing lab archive
was verified and used with `prepare_desktop_driver.py --archive`. No production
resource or credential was copied. Do not rebuild after granting without warning
the owner that ad-hoc signing may invalidate the grant.

Fresh native probe: unlocked, Accessibility false, Screen Recording true. The
driver reports the test bundle ID, not production. This is driver attribution
evidence, not a TCC-log audit. NSWorkspace confirms the exact test bundle is active;
CoreGraphics confirms its on-screen 560 by 432 window. No screenshot was taken.
Owner action: in **FarFromDesk Owner View Test**, click Request Accessibility,
then enable only that test entry in macOS Settings. Do not remove or change
FarFromDesk production entries. Click Check permissions after granting. If the
entry is absent, add the exact bundle above using Finder. No grants were requested
or approved by the agent.

Viewer wiring: the optional final argument to `dist/owner-view/main.js` selects
the named helper, retaining production defaults for existing callers. After
permission and unlocked readiness checks, use:

```sh
node dist/owner-view/main.js SAFE_FIXTURE_PID SAFE_WINDOW_ID /tmp/ffd-owner-session-state build/owner-view-test/native 'FarFromDesk Owner View Test.app'
```

This performs readiness checks before starting the loopback viewer. Pairing code
is terminal-only; do not publish it or put it into a URL. Actual selected-window
capture/click/typing remains blocked by missing Accessibility. The disconnected
browser preview is explicitly labeled and does not claim a live connection.
Phone transport and live Meta integration remain unconfigured.

Verification: TypeScript build passed, 12 owner-view tests and 12 desktop-control
regression tests passed. Expiry/Stop/permission denial tests use fake native
backends; they are not evidence of live input or live screenshots.


## Owner grant follow-up, 27 October

The visible app showed both grants, but direct shell-spawned helper/driver still
reported AX denied. Added test-only LaunchServices launch with private 0700
directory, 0600 FIFOs, correlated commands, timeout/abort and no automatic replay.
Production driver launch stays direct by default. The helper app was NOT rebuilt
and no grants were altered. Fresh LaunchServices preflight: UNLOCKED, both grants
true. Host bundle label alone had not established actual grant attribution.

Real capture exposed a /var versus /private/var canonical-path mismatch. Compare
real paths now; temporary image cleanup is preserved. Adapter regression uses a
canonicalized return path. Cua structured elements are explicitly partial; unknown
completeness fails closed except for the deliberately controlled lab fixture.
This limits the current trial to that fixture, not arbitrary desktop applications.

Real native backend captured the fixture at 1200x1096 and found two editable fields.
One intervening readiness check correctly refused an off-screen target; explicitly
reopening the fixture restored visibility. No input actions were replayed or sent.
TypeScript build and 24 tests passed. Started the real loopback viewer in a private
Terminal, opened the browser, and verified HTTP 200. One-time code remains only
in Terminal. User must pair and refresh; session expires after five minutes.
Actual browser-operated clicks/typing and phone transport remain unverified.


## Autonomous live trial

Ran the real loopback claim/frame/action/stop routes with the native test helper.
The browser's old session had expired; this was HTTP/native integration testing,
not automated browser DOM testing. Pairing credentials remained in memory.

Found and fixed stale typing tokens: pre-action inspection publishes a newer AX
snapshot. Rematch the selected field by role, label and geometry uniquely, then
use its fresh token. Ambiguous or moved fields are rejected. Regression now
rotates tokens on each inspection and checks both ambiguity and movement.
One later post-action readiness failure happened after typing took effect; an
independent field read confirmed the insertion. The action was not replayed.
Shared fixture visibility/focus was unreliable across Spaces. A new isolated
fixture instance with independent state was used for the final click trial.

Verified: screenshot 1200x1096, typed marker read from native AX value, duplicate
action rejection, picture-coordinate Increment click (counter 0 to 1, verified
from isolated fixture JSON and screenshot), stale frame refusal at 5.1 seconds,
Stop rejects subsequent frame access. A separate real one-second expiry timer
closed its listener, called Stop on an unstarted native backend and rejected
pairing. It did not exercise permission revocation or live lock transitions.

Final click evidence: docs/evidence/owner-view/live-trial-1793089390176.
Typing success: docs/evidence/owner-view/live-trial-1793089195609.
No production binary or native grant changed. Phone transport, broad desktop
control, browser-rendered interaction testing and live Meta integration remain
unverified. All harness sessions were stopped after the checks.

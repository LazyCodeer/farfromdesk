# Owner-operated remote assistance: local increment

Status: implemented local-only prototype, focused tests pass. **Not an installed feature, not a phone-accessible remote desktop, and not a completed hackathon entry.** Existing public app and running bridge are unchanged.

## Product and architecture

Telegram is the authenticated request/notification entry point. The proposed remote product opens a short-lived owner browser view from Telegram. The owner sees one explicitly selected window and personally clicks or types. An agent cannot obtain the cookie or use this API through the existing worker/proxy token. Meta explanations are optional suggestions, never driver commands. This separates owner input from agent authority.

This increment implements the local view and boundary as independent modules under `src/owner-view`. It uses the existing bundled Cua adapter instead of creating another automation engine. It does not modify the shared server, native helper, Telegram routing, desktop UI, credential store, or agent permissions.

Start is local opt-in. One 256-bit pairing code is entered on the local view, consumed once, and exchanged for an HttpOnly, SameSite=Strict cookie. Codes are not in URLs; frames/input are not stored in the database or audit log. The local terminal prints the pairing secret only for the owner, so do not save/share its output. Session lifetime is five minutes; restart invalidates all credentials. Exact Host and Origin checks reject other sites and DNS rebinding. No CORS permission is granted.

All capture/input uses one pinned process/window. Screenshots have a five-second action lifetime; clicking uses normalized coordinates relative to the displayed image, mapped to original pixels, not global monitor coordinates. Each action consumes its frame before dispatch, and each UUID can be attempted once. Unknown results stop the session. No automatic replay. The owner refreshes and verifies the result. Typing requires the owner to select one observed editable field; its private native token remains server-side. Control characters/Return are excluded. Ordinary accessible windows are supported; security apps, protected fields and incomplete/sensitive window trees are refused. This does not promise interaction with macOS authorization sheets.

The visible Stop, Ctrl-C, session expiration and native permission/session check terminate the owned driver. A Stop cannot retract a previously dispatched OS event. Driver reuse is subject to the existing host scope and permissions. The local control socket and same-user processes are not an OS sandbox.

## Running the local increment

Use the current desktop-control checkout, not the older dirty main checkout:

```
npm run check
npx --no-install tsx --test test/owner-view.test.ts
npm run build
swiftc native/owner-view/session-state.swift -o /tmp/ffd-owner-session-state
node dist/owner-view/main.js PID WINDOW_ID /tmp/ffd-owner-session-state
```

PID and WINDOW_ID must be the owner's chosen visible target, obtained through the existing desktop inventory. Do not guess or repurpose a private app. Native helper and pinned driver must first be prepared using the existing packaging process; the source checkout alone is not a packaged app. The command fails closed if any prerequisite is unverified. Open only the localhost URL printed by the process and enter its one-time code. Keep the browser visible; hiding it clears the displayed frame and disarms clicks.

Native validation follow-up: the initial probe incorrectly treated an absent lock flag as inconclusive. Upstream Cua session.rs documents that an unlocked session omits this flag. The corrected probe accepts absence only with graphical session access (Security SessionGetInfo), a valid current-session dictionary, active console and completed login. Missing dictionary, inactive session, failed graphical access or malformed flag still fail closed. Nine native evaluation cases pass. The fresh live probe explicitly returned SESSION_LOCKED; no screenshot/input was attempted through that lock. The undocumented lock-key behavior remains a compatibility dependency; real unlock/relock, sleep and fast-user-switch transitions still need testing. No claim of general lifecycle validation is made.

## Meta contribution

The proposed essential Meta feature explains the currently selected application's visible context and proposes the next useful workflow step. The owner can ask for an explanation when a workflow stalls; the response never dispatches input. A stronger demo should compare the proposed step with the subsequent observed result.

`meta.ts` implements an OpenAI-compatible chat-completions adapter for an explicitly configured **eligible Meta model**. It does not silently substitute another model. Configure `FFD_META_ENDPOINT`, `FFD_META_MODEL`, and `FFD_META_KEY` locally, never in chat or source control. HTTPS is required except loopback local inference. The owner must check a consent box for each request; only bounded visible control labels/roles are sent, not the screenshot or typed values. Responses are displayed as text, not HTML or executable actions. Remote content is explicitly untrusted.

This adapter is tested with a fake service only. No eligible endpoint/model/key was provided or read from private state. Actual Meta authentication, model identity, inference, accuracy and hackathon eligibility remain unverified. Do not call this a working Meta integration until an eligible model is configured and a live inference is recorded. Meta Model API protocol compatibility also requires verification against the selected endpoint, rather than assuming it supports this request shape.

## Phone transport decision still required

The implemented listener is **127.0.0.1 only**, never a public service. Its link cannot work on a phone just because Telegram displays it. Do not expose the existing bridge admin port or proxy this listener publicly unchanged. Its cookie is intentionally scoped to loopback HTTP and is not a public deployment configuration.

Recommended first remote transport: a private authenticated network between the owner's phone and Mac, or a separately reviewed HTTPS rendezvous/relay with short-lived identity-bound pairing and owner confirmation. A real remote gateway must authenticate the Telegram owner, bind the viewer to the same owner/device, use secure cookies, protect Origin/CSRF and framing, handle disconnect/revocation, limit sessions, rate-limit pairing, and validate request provenance without persistent bearer links. Remote deployment/account/network setup is an essential decision and is not authorized merely by this prototype.

## Lock, sleep, offline

| State | Supported claim |
| --- | --- |
| Unlocked active GUI, both grants, exact visible target | Candidate for live local tests; not yet verified for this increment |
| Locked or unknown GUI state | Refuse capture/input and stop session; no password entry through Telegram |
| Sleeping Mac | No live service guarantee; explicit keep-awake policy would need its own owner choice |
| Offline/disconnected Mac | No live view/control; never queue and replay clicks when it returns |
| macOS permission prompt/security app | Owner handles native consent locally; not auto-approved by agents or this view |

## Verification recorded

`npm run check` passes. Ten focused tests pass, including native-adapter coordinate mapping and observed-field targeting, plus: one-use pairing/auth/expiry; stale and duplicate action rejection; coordinate/text validation; simulated lock/permission loss; unknown-action stop; Stop while capture is pending; real loopback HTTP origin/cookie/cache/revocation; and mocked Meta context isolation. No real screenshot or input is used by those tests. The native session probe compiled and nine evaluation cases passed; live startup is currently blocked by an explicit SESSION_LOCKED result. Browser UI behavior is not yet manually validated. Full end-to-end phone control, real permission revocation/lock transitions, native typing, screenshots, and Meta inference remain pending.

## Hackathon contribution and provenance

Official guide: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details

The guide identifies Meta Model API and Meta open-weight models as the technical basis. Pure remote sharing is insufficient for the requested entry. Track/participant eligibility and exact submission requirements still need confirmation from the official participant guide. The delegated brief reports equal weights for impact, creative Meta use, technical execution and demo, a public submitted repo, a three-minute video, and up to four participants. Deadline in that brief: 4 Nov 2026 9 PM EST, which is **5 Nov 2026 7:30 AM IST**. These submission-specific details were not independently verified from the unauthenticated details page.

Preexisting FarFromDesk code and the previously implemented desktop driver must be identified as prior work. New work in this increment: owner-only expiring session boundary, loopback manual visual-control UI, scope/availability checks, optional Meta explanation adapter and tests. No dates/history were rewritten, no submission made, no credits claimed, no public service deployed. Before submission: verify track eligibility, implement/validate the remote transport and native lifecycle, complete live Meta evaluation, obtain consent for demo contents, and record the actual three-minute video.

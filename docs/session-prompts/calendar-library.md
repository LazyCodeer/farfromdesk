# New task: Calendar via EventKit (or an existing library), not hand-written AppleScript

**Stop the current task.** The AppleScript Calendar pack you were writing is superseded. Bring the current file edit to a compiling state, leave it, and do the work below instead. Two reasons: (1) Apple's own supported API for Calendar is **EventKit**, not `osascript`, and a ready-made MIT project already demonstrates the helper shape; (2) the TCC research below shows the AppleScript route is the one that silently breaks when the wrong process asks for permission.

## Objective

Decide, with evidence on this Mac, between two routes for Calendar — **EventKit** (Apple's typed API, needs an Info.plist change in our app) and a **ready-made library** — then produce a thin adapter plus the exact patch the integrator must apply.

## Route A — EventKit (Apple's supported API)

- `EKEventStore` + `EKEvent` cover full CRUD. Request with `requestFullAccessToEvents()` (macOS 14+).
- Info.plist keys on the **responsible** process: `NSCalendarsFullAccessUsageDescription` (read+write). The old `NSCalendarsUsageDescription` is deprecated and acts only as a fallback. Write-only access (`NSCalendarsWriteOnlyAccessUsageDescription`, `requestWriteOnlyAccessToEvents`) gives a **virtual calendar** and empty `delegateSources`, so you cannot choose a real calendar — do not pick it.
- **There is no read-only calendar access.** Full or write-only, nothing else.
- TCC consults the *responsible process*: a bare `swiftc` helper spawned by our backend that lacks the key gets an instant, silent `false`, with no dialog and no entry in the privacy pane (documented in the wild for cmux and T3 Code hosts, macOS 26). The dialog also needs a **foreground app with a running run loop** and, on macOS 26, a **notarized** build.
- Our app today declares only `NSAppleEventsUsageDescription` in `desktop/macos/Runner/Info.plist`. Adding the calendar key is part of the integrator patch — and the existing `native/*.swift` helpers show how the ship script already compiles one binary per helper.

## Route B — a ready-made library

- https://github.com/Ktesio/bite-mcp — **MIT**, Rust control plane + **native Swift helper (EventKit + ScriptingBridge)**, 45 tools + CLI. Its Calendar engine is **EventKit (native)**: list, search, get, create, update, delete, availability/free-busy. This is the closest existing implementation of what we want, and its helper carries its own embedded Info.plist (the README says helpers embed usage descriptions so spawned processes are not silently rejected).
- https://github.com/MrGo2/icloud-mcp — **MIT, 74★**, npm `mcp-icloud`: Calendar via iCloud **CalDAV** with an app-specific password. Calendar-over-CalDAV works (RFC 4791 + RFC 5545); the server is `caldav.icloud.com`, discovery via `/.well-known/caldav`, and the home set lands on a per-account partition host like `p67-caldav.icloud.com`, so no URL can be hardcoded. No push — changes are polled. App-specific passwords require 2FA, cap at 25, and **all are revoked when the Apple Account password changes**.

## Work tree and rules (unchanged)

Work tree `/private/tmp/ffd-pr`, branch `codex/local-desktop-work`, **shared**. Same context files as before.

1. **New files only** in the repo. Never edit `package.json`, `packs.ts`, `retrieve.ts`, or any existing file; the exact patch goes in your report.
2. No `ffd ship`, no app build, no full-suite run, no commit.
3. Installing into `/tmp` is allowed (`CARGO_INSTALL_ROOT=/tmp/bite cargo install bite-mcp`, `npm i --prefix /tmp/icloud-mcp mcp-icloud`). Do **not** add a dependency to the repo.
4. A real Calendar run needs the owner's one-time permission click. Ask in your report; do not assume it. Creating and deleting **one throwaway event in a scratch calendar** is the most you may attempt.
5. "Compiled", "unit-tested", "ran live" are three different claims.

## Verification ladder

- **V0** — install or compile, and prove which engine you got (EventKit vs AppleScript): for bite, look for the Swift helper and the absence of `osascript`; for a direct EventKit probe, a tiny Swift file that prints `EKEventStore.authorizationStatus(for: .event)`.
- **V1** — list the calendars and read one event's fields.
- **V2** — create one throwaway event, update it, delete it, reading it back after each step. Own data only; if the grant is missing, stop here and report exactly what the prompt did (dialog shown? silent false? privacy-pane entry?).
- **V3** — the adapter compiles and its tests pass.
- **V4** — the integrator patch (including the exact Info.plist lines) and your route recommendation.

## Deliverables (new files only)

- `src/app-tools/adapters/calendar.ts` — a thin adapter exposing the chosen route behind **our** `AppTool` interface: `calendar_find_events`, `calendar_read_event`, `calendar_update_event`, `calendar_delete_event` (do **not** redefine `calendar_create_event` / `calendar_list_events`). Our policy applies regardless of the engine: exact-match identification, refuse 0 or >1 matches, refuse recurring events, refuse events with attendees on delete (deleting an invite can mail a cancellation to other people), read back after every write, refusals as sentences, never invite/mail/send.
- `test/app-tools/calendar-adapter.test.ts` — pack invariants; selection for `"what is on my calendar on friday"`, `"find the meeting with the team"`, `"move my dentist appointment to 6pm"`, `"delete the event called standup confirm standup"`, `"am I free tomorrow"` (with `app:'Calendar'`); non-selection for `"write the failing test"`, `"add a retry to the sync loop"`, `"where is the router contract code"`, `"create a new session for this"`; and that no script or plan can invite or send.

## Questions your report must answer with evidence

1. Which route did you verify, and what exactly proved it (status code, helper binary, absence of `osascript`)?
2. What did the permission dialog actually do from our app's context? Name the prompt, the pane entry, and whether a denial is sticky.
3. If you went the library route: does its helper carry its own Info.plist, is it notarized/signable, and what does `bite setup` rewrite on a user's Mac?
4. If you went EventKit: the smallest Swift surface that does find/read/update/delete, and how the ship script should compile and bundle it.
5. Vendor vs depend vs write-the-EventKit-call-ourselves: one paragraph with a recommendation.

## Report format (short and factual)

- Session id; files created with `wc -l`; exact commands and `# tests / # pass / # fail`; ladder rung reached with evidence; the integrator patch; what you could not do.

## Revision 2 (4 November 2026) — the signed-helper route, and the exact cost of Route B

Research landed after this file was written. The new fact that changes the decision: a signed helper binary
carries its own identity, so TCC attributes the grant to it instead of to `node` — which is what makes the
library route worth proving rather than reimplementing.

- **Route A (try first):** `FradSer/mcp-server-apple-events` (233★, MIT, npm 1.6.2, 2026-10-27) ships a
  **prebuilt, universal, code-signed `bin/event`** EventKit binary. Prove it end to end and report whether the
  Calendar grant landed on that binary or on our app. A binary in our repo would need our signature instead —
  say what that changes.
- **Route B (our own Swift EventKit helper):** the real cost, itemised —
  `NSCalendarsFullAccessUsageDescription` (and `NSCalendarsWriteOnlyAccessUsageDescription` if used) added to
  `desktop/macos/Runner/Info.plist`; the helper's plist embedded in the Mach-O
  (`-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist`) and/or its own bundle or launchd identity;
  the first grant made from a **foreground app with a running run loop** (`setActivationPolicy(.regular)` +
  `app.run()`), because a bare CLI request silently returns `false` with no dialog; a **notarized** build,
  since macOS 26 kills ad-hoc builds during the dialog; and `tccutil reset Calendar <bundle-id>` as the only
  recovery, because a denial is sticky and never re-prompts.
- EventKit facts to respect either way: typed `EKEvent` CRUD via `requestFullAccessToEvents()`; **no
  read-only calendar access**; write-only mode returns one virtual source, empty `delegateSources` and a
  virtual `defaultCalendarForNewEvents`; the API is device-local, so no server can call it.
- **Route C (CalDAV, `icloud-mcp` cloud mode):** `caldav.icloud.com` then `/.well-known/caldav` and two
  PROPFINDs; the home set lands on a per-account partition host such as `p67-caldav.icloud.com`; no push;
  reads are range-capped (about a year); auth is an app-specific password (2FA required, max 25, all revoked
  when the Apple Account password changes).
- Also compare against `Omar-V2/mcp-ical` (333★ MIT but stale since 2025-04-21) and `PsychQuant/che-ical-mcp`
  (108★, MIT, Swift EventKit) so the choice is not made on stars alone.
# New task: Reminders via an existing library (EventKit), not hand-written AppleScript

**Stop the current task.** The AppleScript Reminders pack you were writing is superseded. Do not delete what you have — bring the current file edit to a compiling state, then leave it. From here, do the work below. The reason: a ready-made MIT implementation already exposes Reminders CRUD, and it does it through **EventKit natively instead of AppleScript**, which is both more reliable and the permission model Apple actually supports.

## Objective

Prove — on this Mac, with evidence — whether **`Ktesio/bite-mcp`** can serve as the Reminders API behind our pack interface, and if it can, produce a thin adapter plus the exact patch the integrator must apply. If bite is unusable, say so with the evidence and evaluate the fallback (`MrGo2/icloud-mcp`, AppleScript-based) against it.

## The library

- Repo: https://github.com/Ktesio/bite-mcp — **MIT**, Rust control plane + **native Swift helper (EventKit + ScriptingBridge)**, "no `osascript` processes, no Python".
- 45 MCP tools + mirrored CLI verbs, e.g. `bite reminders lists`, `bite reminders create "Water the plants" --due "tomorrow 9am"`.
- Reminders engine per its README: **EventKit (native)** — lists, search, create (with alarms), update/complete, delete.
- Other apps in the same package (for context only): Calendar (EventKit), Mail (ScriptingBridge, includes send), Notes (ScriptingBridge), Contacts, Messages.
- Install path from its README: `cargo install bite-mcp` then `bite setup` (which writes MCP config into detected agents). Do that in a scratch target dir, **not** into this repo's config.
- Fallback: https://github.com/MrGo2/icloud-mcp — **MIT, 74★**, npm `mcp-icloud`, AppleScript locally or iCloud CalDAV/IMAP in cloud mode.

## Work tree and rules (unchanged)

Work tree `/private/tmp/ffd-pr`, branch `codex/local-desktop-work`, **shared**. Same context files as before.

1. **New files only** in the repo. Never edit `package.json`, `packs.ts`, `retrieve.ts` or any existing file; put the exact patch in your report.
2. No `ffd ship`, no app build, no full-suite run, no commit.
3. Installing bite in a scratch prefix (`CARGO_INSTALL_ROOT=/tmp/bite cargo install bite-mcp`) or iCloud-mcp via `npm i --prefix /tmp/icloud-mcp` is allowed. **Do not** add either to the repo's dependencies.
4. Never claim "ran live" for something you did not run against the real Reminders app. "Compiled", "unit-tested", "ran live" are three different claims.
5. A real run needs the owner's one-time Reminders permission click; ask for it in your report rather than assuming it. One throwaway reminder in a scratch list is the most you may attempt without it, and only if bite's own `setup` already made a list.

## Verification ladder

- **V0** — install and run its CLI help; list `bite reminders` verbs; confirm it is EventKit and not AppleScript (look for the Swift helper and the absence of `osascript`).
- **V1** — create and read back one throwaway reminder through the CLI, in a scratch list, no owner data.
- **V2** — complete and delete that same throwaway reminder, proving the full CRUD path.
- **V3** — the adapter below compiles and its tests pass.
- **V4** — the integrator patch and the vendoring recommendation with evidence.

## Deliverables (new files only)

- `src/app-tools/adapters/reminders.ts` — a thin adapter that exposes bite behind **our** `AppTool` interface, with our policy: `reminders_open`, `reminders_read`, `reminders_complete` (requires `confirm` equal to the reminder's own name), `reminders_update`, `reminders_delete` (confirm required, never bulk), correct `writes`, descriptions ≥3 sentences with an explicit negative, ≥2 owner-voice examples, ≥4 keywords.
  - Keep the existing vocabulary ban: never use the words `task`, `tasks` or `todo` (this product calls coding work "a task"; those words already dragged `reminders_add` into `"add a checks column to task_contracts"`).
- `test/app-tools/reminders-adapter.test.ts` — pack invariants; selection for `"what reminders do i have open"`, `"anything I have to do today"`, `"show me my reminder about the plumber"`, `"mark buy milk as done"`, `"change the plumber reminder to friday"`, `"delete the reminder called buy milk confirm buy milk"` (with and without `app:'Reminders'`); non-selection for `"add a checks column to task_contracts"`, `"write the failing test"`, `"add a retry to the sync loop"`, `"create a new session for this"`; confirm-required refusals are sentences, not throws.

## Questions your report must answer with evidence

1. Does bite's Reminders path really use EventKit (native) with no `osascript`? How did you verify?
2. What does `bite setup` write where — and what must the integrator do to avoid it rewriting agent configs on a user's Mac?
3. Permissions: which TCC prompts appear, and are they attributed to *our* app or to bite's helper? That attribution decides whether we can ship it.
4. Where does its data live (`~/Library/Application Support/bite/bin/` from the README) and what does that cost us at install/upgrade time?
5. Vendoring vs dependency vs reimplement-the-EventKit-call: one paragraph each, with a recommendation.
6. What is the honest comparison against icloud-mcp (AppleScript) — reliability, permissions, footprint?

## Report format (short and factual)

- Session id; files created with `wc -l`; exact commands and `# tests / # pass / # fail`.
- Ladder rung reached with evidence; the integrator patch; what you could not do.

## Revision 2 (4 November 2026) — better candidates than bite-mcp

Research landed after this file was written. `Ktesio/bite-mcp` is 1★ and installs a Rust control plane
(`cargo install bite-mcp`, then `bite setup` rewrites agents' MCP configs). Prefer these, which are EventKit
and already proven:

1. `FradSer/mcp-server-apple-events` (233★, MIT, npm 1.6.2, 2026-10-27) — Reminders and Calendar through
   **EventKit**, and it ships a **prebuilt, universal, code-signed `bin/event` Swift binary**, so no Xcode is
   needed and the TCC grant attaches to that signed binary rather than to `node`. Node 20+, macOS.
2. `openclaw/remindctl` (412★, MIT, `brew install steipete/tap/remindctl`) — **already installed on this Mac
   as `remindctl 0.1.1`**. EventKit; `add / edit / complete / delete / list / search / info / export / doctor`;
   documents "macOS 14+" and full Reminders access for the terminal app that runs it.
3. `MrGo2/icloud-mcp` (74★, MIT) — keep as the fallback, with the VTODO caveat: only lists never upgraded
   since iOS 13 / macOS 10.15 are reachable over CalDAV, "on some accounts that is zero lists".

The TCC trap that decides this: the grant belongs to the **launching host**, not your binary. A Node child of
a bundle without the entitlement fails with `kTCCServiceCalendar requires entitlement
com.apple.security.personal-information.calendars ... missing for responsible=.../node` (FradSer #83), and
headless Node / Bun / Python are blocked outright (#93). That is the whole reason to prefer a signed helper
binary, and it is worth stating in your report whether the grant landed on the helper or on our app.

Also: EventKit has **no write-only reminders level** and grants are per host — a grant made from Terminal
does not authorize our app.
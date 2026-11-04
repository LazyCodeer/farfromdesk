# Per-app tool APIs: the plan (4 November 2026)

Three sessions work in parallel, one app each, each in its own files. This document is the
contract they share. It exists because of a real failure: the owner asked **"Give me summary of
all the notes"** and the companion answered with the accessibility labels of the visible Notes
window. It could point, click and read *chrome*; it could not read *content*.

## The rule that changes everything

**An answer must come from a read that could have produced it.**

- `read_window` reads the visible window's accessibility tree. It is chrome: toolbar buttons, list
  row titles, the first screenful of whatever is on screen. It is never a source for "summarise my
  notes", "what did I write about X", or "what is on my calendar next week".
- A question about data therefore needs a **data tool** (AppleScript against the app's dictionary, or
  the driver's page/text calls), and the answer must be built from what that tool returned.
- When no reviewed tool can read the data, the honest answer is a refusal that names the gap — not
  a dump of labels with "I read X" on top.
- Evidence is not an answer. If a tool returns 400 lines, the companion summarises them; the raw
  lines may follow as evidence, never as the reply itself.

## What a tool is

Every tool is a reviewed function, not a prompt. In `src/app-tools/types.ts`:

```ts
interface AppTool {
  name: string;            // pack_prefixed_snake_case, unique across all packs
  pack: string;            // 'notes' | 'calendar' | 'reminders' | ...
  app: string;             // user-visible app name, e.g. 'Notes'
  bundleId?: string;       // e.g. 'com.apple.Notes'
  description: string;     // 3-5 sentences: what it does, when to use it, when NOT to
  args: AppToolArg[];      // each named and described
  examples: string[];      // the owner's own phrasings, no proper nouns
  keywords: string[];      // the words the owner uses, for lexical retrieval
  writes: boolean;         // true only if it changes data on the Mac
  notFor?: string[];       // near-miss intents this tool must not answer (>=2 words each)
  plan(args): AppToolPlan; // {kind:'steps',steps:[...]} or {kind:'osascript',script}
}
```

Retrieval details that have already cost time and must not be re-learned:

- The description, examples and keywords **are the retrieval corpus**. A proper noun in an example
  (a person's name) drags the tool into unrelated requests — it happened with "Ashitosh".
- `notFor` beats scoring, so a near-miss ("find a note" for a tool that cannot search) is excluded
  rather than ranked low.
- `writes` drives polarity: a request whose opening verb is a read verb never gets a writing tool
  and the reverse. `list` is excluded from the read verbs because it is a noun in "on my list".
- Naming an app or pack narrows retrieval to that pack; the frontmost app is a prior, not a
  permission.
- Descriptions must never contain `task`, `tasks` or `todo` for Reminders — this product calls
  coding work a task, and those words put an add-reminder tool in front of
  "add a checks column to task_contracts".

## Two mechanisms, chosen deliberately

| | Accessibility steps (`kind:'steps'`) | AppleScript (`kind:'osascript'`) |
|---|---|---|
| Reaches | the UI: focus, click, type, menus | the app's data model: notes, events, reminders |
| Permission | Accessibility + Screen Recording (already granted) | one-time Automation (TCC) allow-click per app |
| Background | yes, never steals focus | yes |
| Good for | actions with no dictionary, browser tabs, menus | CRUD on the owner's data |

Rule: **data goes through AppleScript, pixels go through steps.** Never mix them silently inside one
plan.

Not yet granted: Calendar, Reminders and the Notes body scripts have never run live. Their first run
raises the macOS Automation dialog. A session must say "not run live" until a human has clicked it.

## Known AppleScript surface (measured against the macOS 27.0.1 dictionaries)

Cached dictionaries: `/tmp/sdef_Notes.xml`, `/tmp/sdef_Calendar.xml`, `/tmp/sdef_Reminders.xml`,
`/tmp/sdef_Mail.xml`, `/tmp/sdef_Finder.xml`, `/tmp/sdef_Safari.xml`, `/tmp/sdef_Messages.xml`,
`/tmp/sdef_Music.xml`.

- **Notes**: `every note`, `note "N"`, `body` (writable), `name`, `creation date`,
  `modification date`, `container`, `every folder`; `make new note at folder "X" with properties
  {name, body}`.
- **Reminders**: classes `account`/`list`/`reminder`; `make new reminder at end of reminders of
  list "X" with properties {name, body, due date, remind me date, priority, flagged, completed}`;
  `reminders of l whose completed is false`; `set completed of r to true`; `delete r`.
- **Calendar**: `make new event at end of events of calendar "Home" with properties {summary,
  start date, end date, location, allday event}`; `every event of c whose start date ≥ …`;
  `recurrence` is empty for a one-off; `attendees` exists — deleting an event with attendees can
  mail a cancellation, so it is refused.
- Always build dates from parts (`appleDateAssign`/`appleDateParts` in `src/app-tools/packs.ts`):
  a `date "…"` literal is coerced by the Mac's own locale and has broken before.
- Always escape with `asStr`. `/usr/bin/osascript -e <script>`; a missing grant surfaces as
  `-1743` / "not authorised" and is mapped to a permission sentence by the caller.

## CRUD coverage per app

| App | Read all | Find | Read one | Create | Update | Delete | Mechanism | Risk |
|---|---|---|---|---|---|---|---|---|
| Notes | ✅ list | ✅ find (titles) | ✅ body | ✅ | ✅ append/replace | ✅ confirm | AppleScript | low |
| Reminders | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ confirm | AppleScript | low |
| Calendar | ✅ range | ✅ text/date | ✅ | ✅ | ✅ exact match | ⚠️ confirm, refuse recurring/attendees | AppleScript | medium |
| Mail | ⚠️ read inbox | ⚠️ | ⚠️ | ✅ draft only | ✖ | ✖ | AppleScript | high — never send |
| Finder | ✅ list/reveal | ✅ | ⚠️ | ✅ folder/file | ⚠️ rename | ⚠️ trash only | AppleScript + steps | medium |
| Safari | ✅ tabs/reading list | ✅ | ✅ page text | ✅ open URL | ✖ | ⚠️ close tab | driver + AppleScript | low |
| Messages | ⚠️ chats | ✖ | ✖ | ✖ | ✖ | ✖ | — | high — never send |
| Music | ✅ library | ✅ | ⚠️ | ✅ playlist | ⚠️ | ⚠️ | AppleScript | low |

"⚠️" means: build only with an explicit guard and a refusal path, and never in the same session as
another app.

## Verification ladder (every tool climbs it)

- **T0** the plan's script compiles: `osacompile -o /tmp/x.scpt /tmp/x.applescript` (a suite test).
- **T1** the plan is refused correctly for bad or missing arguments (readable sentence, not a throw).
- **T2** retrieval: the owner's real phrasings select it; coding phrasings do not (golden + tests).
- **T3** a fake driver/`string` assertion proves the exact script or step list sent.
- **T4** a live run on the owner's Mac, with the TCC allow-click, reading the real app.
- **T5** read-back: after a write, the tool reads the changed thing and returns proof; a test asserts
  the returned line contains that proof.

T4 is the only step that is currently outstanding for Calendar, Reminders and the Notes body tools.
Nothing may be described as working until T4 and T5 have both happened.

## What each parallel session delivers

Session files (new files only — no session edits any existing file):

- `src/app-tools/packs/<app>.ts` — the pack, exporting `AppPack`.
- `test/app-tools/<app>.test.ts` — its tests (invariants, retrieval, refusals, compile, read-back).

Existing names must not be redefined (`notes_create_note`, `notes_find`, `reminders_add`,
`reminders_list`, `calendar_create_event`, `calendar_list_events`). New tools use new names.
A separate **integrator session** (asked for by the owner once the packs are in) then:

1. moves the app's existing tools into the app's own file,
2. registers the pack in `src/app-tools/packs.ts`,
3. extends `golden.ts` / `golden-paraphrase.ts` with the new rows,
4. runs `npm run evals` (gate must pass), the full suite, and `npx tsc --noEmit`,
5. builds with `ffd ship`, runs the live transcript, and records the result in
   `docs/skills/ffd-local-development/references/current-state.md`.

## Definition of done for the owner's failure

"Give me summary of all the notes" is fixed only when: a content tool reads the note bodies, the
answer is built from them, a test pins the routing (a summarise request never resolves to
`read_window`), and a live run on the owner's Mac produces a real summary. Anything less is
infrastructure.

## Revision (4 November 2026): reuse before rewrite

Two research passes — Apple's first-party APIs, and a survey of what already exists in the open — changed
two things in the plan above. Everything in the "rule that changes everything", the tool interface, the
retrieval rules, one-action-at-a-time and the T0–T5 ladder stands unchanged. Those are our layer.

### 1. The engine per app, decided by evidence

| App | Engine | Why |
|---|---|---|
| Notes | AppleScript (`osascript`), plus read-only `NoteStore.sqlite` for fast listing | Apple has **no** Notes API of any kind; AppleScript is the only supported, documented way to read a body |
| Calendar, Reminders | **EventKit** through a signed helper | typed `EKEvent`/`EKReminder` CRUD, no GUI scripting, works headless after one grant |
| Mail | AppleScript to Mails.app for draft/send; IMAP + SMTP only for unattended | MailKit is an app-extension SDK, not a mailbox API; no other first-party path |
| Safari / Finder / Music / Messages | as measured above | unchanged |

### 2. Prove an existing client before writing another one

- Notes: `mgcrea/cupertino` (`@mgcrea/mcp-apple-notes`, MIT, writes off per surface) or
  `sweetrb/apple-notes-mcp` (176★, MIT). The correctness reference is `RhetTbull/macnotesapp`
  (273★, MIT, Python): copy its guardrails, not its runtime.
- Calendar + Reminders: `FradSer/mcp-server-apple-events` (233★, MIT) — it ships a **prebuilt,
  code-signed EventKit `bin/event`**, which is precisely what moves the TCC grant off `node` and onto the
  helper — and `openclaw/remindctl` (412★, MIT, already installed on this Mac as 0.1.1).
- Fallback: `MrGo2/icloud-mcp` (74★, MIT) — AppleScript locally, or IMAP/CalDAV/CardDAV in cloud mode.
- One trap in cloud mode: Reminders over VTODO only reaches lists never upgraded since iOS 13 / macOS 10.15,
  and "on some accounts that is zero lists".

### 3. Traps that belong in the code, not only in the docs

- `body` is HTML and read/write; `plaintext` is read-only; there is no `save` command. Bulk `body` reads are
  broken on macOS 26, so reads iterate per note. Inline images are base64 (a 40 MB image makes a ~110 MB
  body; 512 MB cap), and writing such a body back bakes the placeholders in as text.
- Writes can land **more than 20 s late, or never**, and a deleted folder can reappear within the hour — so a
  write tool reads back and reports "not confirmed yet" instead of claiming success.
- A note with attachments, checklists or native tags cannot be round-tripped without loss; refuse that edit.
- EventKit TCC is attributed to the **responsible** process. A Node child of a bundle without
  `com.apple.security.personal-information.calendars` or the `NS*UsageDescription` keys is denied instantly
  and silently, with no dialog and no privacy-pane entry. The first grant needs a foreground app with a
  running run loop, macOS 26 wants a notarized build, a denial is sticky, and the only recovery is
  `tccutil reset Calendar <bundle-id>`.

Sources: the two research reports of 2026-11-04 (subagent `fcbad658` for first-party APIs, subagent
`f2f1807c` for the OSS survey) and GitHub/npm/Homebrew metadata for every project named above.
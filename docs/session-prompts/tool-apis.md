# Task: own the whole per-app tool layer (one session, all apps)

**Read this file first, then the three app files' "Revision 2" sections** (`1-notes.md`,
`2-reminders.md`, `3-calendar.md`) for the traps. This file supersedes their "new files only, one app each"
split: the owner wants **one session to own every app tool**, because a single app was the wrong unit. The
unit is the layer.

## Why the plan changed

The first version of this work split into three sessions, one app each, each creating only its own file. The
owner's words: one session should handle **all** of those tools, not three tools for three apps. Merging them
also removes the only real reason for the split — merge conflicts — because there is now exactly one writer.

## Ownership (you are the sole writer of these paths)

- `src/app-tools/**` — `types.ts`, `packs.ts`, `packs/<app>.ts`, `adapters/<app>.ts`, `retrieve.ts`,
  `embed.ts`, `golden.ts`, `golden-paraphrase.ts`, `metrics.ts`.
- `test/app-tools/**` and `script/run_brain_evals.mts`.
- `src/desktop-control.ts` only at the `packTool` seam, and only to add a new plan kind.
- **Not yours:** `src/router.ts`, `src/meta-brain*.ts`, `src/brain-device.ts`, `src/meta-model.ts`,
  `src/store.ts`. Note the required change and hand it to the integrator (the parent session) — do not edit
  those files.

Repo: `/private/tmp/ffd-pr`, branch `codex/local-desktop-work`. The tree is shared, so run `git status`
before every write and touch only your paths. Do **not** build (`ffd ship`), commit, or push; the integrator
does that. Installs into `/tmp` are fine. Never add an npm dependency to the repo without asking.

## Do it in this order, one shippable slice at a time

The owner's actual failure was **"Give me summary of all the notes"**, answered with the visible window's
accessibility labels. Fix that first; everything else is breadth.

1. **Notes content + summary.** Tools: `notes_recent` (most recently modified N notes with their plaintext,
   capped — say 20 notes / ~60k characters), `notes_read` (one note by name or id, body), then
   `notes_create`, `notes_append`, `notes_update`, `notes_delete` (confirm == the note's name).
   The reply to "summarise my notes" must be built from what these returned; a test must pin that the
   routing of a summarise request never resolves to `read_window`.
2. **Calendar and Reminders CRUD** on EventKit (see the engine table), replacing the AppleScript path.
3. **Mail**: read/search plus **draft only**. Never send. Keep the existing approval path.
4. **Finder, Safari, Music, Messages**: only what is already measured in `docs/app-tool-apis.md`'s CRUD
   matrix. Messages and Mail stay read/draft-only.
5. **Retrieval and the scoreboard**: a golden row for every new tool, the matching paraphrase rows, and
   `npm run evals` passing before you call any slice done.

## Engine per app — evidence, not preference

| App | Route | Permission |
|---|---|---|
| Notes | AppleScript/JXA against Notes.app (no first-party API exists); read-only `NoteStore.sqlite` for fast listing | one Automation allow-click for Notes; Full Disk Access only for the SQLite lane |
| Calendar, Reminders | **EventKit** through a code-signed helper | Calendar + Reminders grants, attributed to the signed helper |
| Mail | AppleScript `send`/draft; IMAP `imap.mail.me.com:993` + SMTP `smtp.mail.me.com:587` STARTTLS only, for unattended | Automation for Mail, or an app-specific password |
| Finder, Safari, Music | AppleScript / the driver, as measured | already granted |

Prove an existing client before writing another one:

- Notes: `mgcrea/cupertino` (`@mgcrea/mcp-apple-notes`, MIT — writes off per surface) or
  `sweetrb/apple-notes-mcp` (176★, MIT). The correctness reference is `RhetTbull/macnotesapp` (273★, MIT,
  Python): take its guardrails, not its runtime.
- Calendar + Reminders: `FradSer/mcp-server-apple-events` (233★, MIT; ships a **prebuilt code-signed
  EventKit `bin/event`**, which is what puts the TCC grant on the helper instead of on `node`) and
  `openclaw/remindctl` (412★, MIT, already installed on this Mac as 0.1.1).
- Fallback: `MrGo2/icloud-mcp` (74★, MIT) — AppleScript locally, IMAP/CalDAV/CardDAV in cloud mode; note
  that Reminders over VTODO only reaches lists never upgraded since iOS 13 / macOS 10.15.

Licences: MIT/Apache-2.0 code may be vendored **with attribution**. GPL/MPL binaries (`eventkit-js`,
`eventkit-node`) need a decision first — do not bundle them.

## A new plan kind, because a library is not a script

`AppToolPlan` today is `{kind:'steps'}` or `{kind:'osascript'}`. Add a third:

```ts
| { kind: 'cli'; binary: string; args: string[]; timeoutMs?: number }
```

- `binary` is a bundled helper under the app's `Resources/backend/native/` directory (the ship script
  already compiles Swift helpers there — see `docs/skills/ffd-local-development/scripts/ffd`).
- `args` is an array, never a shell string: no interpolation, no `sh -c`.
- `packTool` in `src/desktop-control.ts` runs it with a timeout and an output cap and maps a missing
  binary to an honest refusal, the same way the osascript path maps `-1743`.
- Put the JSON parsing and the argument validation in `src/app-tools/adapters/<app>.ts` so a plan stays
  declarative.

## Traps that belong in code

- `body` is the note's HTML and read/write; `plaintext` is read-only; there is **no `save` command**. Bulk
  `body` reads are broken on macOS 26 — iterate per note. Inline images are base64 (40 MB image ⇒ ~110 MB
  body, 512 MB read cap), and writing such a body back bakes placeholders in as text.
- Writes can land **20+ seconds late, or never**; a deleted folder can reappear within the hour. So a write
  tool reads back and reports "not confirmed yet" instead of claiming success.
- A note with attachments, checklists or native tags cannot be round-tripped without loss — refuse that edit.
- EventKit TCC belongs to the **responsible** process: a Node child of a bundle without
  `com.apple.security.personal-information.calendars` or the `NS*UsageDescription` keys is denied instantly
  and silently. If you compile our own helper, it needs its plist embedded
  (`-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist`) or its own bundle/launchd identity, the
  first grant from a foreground app with a running run loop, and a `tccutil reset` recovery path.
- Retrieval vocabulary: no proper nouns; `notFor` for near-misses; `writes` drives read/write polarity;
  naming an app narrows to that pack; the frontmost app is a prior, not a permission; and the words
  `task`/`tasks`/`todo` must never appear in Reminders text (they dragged `reminders_add` into
  "add a checks column to task_contracts").

## Verification ladder — unchanged, and enforced

- **T0** every plan compiles (`osacompile` for scripts; the helper exists and reports `--help` for CLIs).
- **T1** bad or missing arguments produce a readable refusal, not a throw.
- **T2** retrieval: the owner's real phrasings select the tool; coding phrasings do not.
- **T3** a fake driver asserts the exact script, step list, or command line sent.
- **T4** a live run on this Mac, with the owner's permission click.
- **T5** after a write, the tool reads the change back and the returned line carries that proof.

Never describe a tool as working before T4 **and** T5. "Compiled", "unit-tested" and "ran live" are three
different claims; say which one you reached.

## Report format

- Files created or changed, with `wc -l`, and the exact commands with their `# tests / # pass / # fail`.
- For each app: the engine you chose and the evidence, the tools added, and the highest ladder rung reached.
- The retrieval numbers from `npm run evals` (golden and paraphrase recall, wrong-first).
- The integrator patch, as a diff summary: file, hunk, why.
- What you could not do, what is blocked on a permission click, and what you did not run.
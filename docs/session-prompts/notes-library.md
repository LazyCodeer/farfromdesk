# New task: Notes via an existing library, not hand-written AppleScript

**Stop the current task.** The AppleScript Notes pack you were writing is superseded. Do not delete what you have — finish the current file edit to a compiling state, then leave it. From here, do the work below instead. The reason: ready-made, MIT-licensed implementations already do Apple Notes CRUD, including full note **bodies**, and we are not going to keep re-writing that by hand.

## Objective

Prove — on this Mac, with evidence — whether **`sweetrb/apple-notes-mcp`** can serve as the Notes API behind our pack interface, and if it can, produce a thin adapter plus the exact patch the integrator must apply.

## The library

- Repo: https://github.com/sweetrb/apple-notes-mcp — MCP server, **TypeScript, MIT**, 176★, 28 forks, npm package `apple-notes-mcp`, CI + OpenSSF scorecard, last push 2 Nov 2026.
- Read/write path (from its README): **AppleScript + Apple Shortcuts + read-only access to the Notes database**.
- Claims: create, search, edit, organize, export notes; folders and accounts; native tags; checklists; tables; pinned notes; links; attachments; export to Markdown/HTML/JSON; audio transcripts and drawings; paragraph anchors; a query language across the library.
- Our reason for caring: the owner asked "give me summary of all the notes" and the companion dumped accessibility labels because it cannot read note **content**. This library reads content.

## Work tree and rules (unchanged)

Work tree `/private/tmp/ffd-pr`, branch `codex/local-desktop-work`, **shared**. Read the same context files as before (`src/app-tools/types.ts`, `packs.ts`, `retrieve.ts`, `docs/app-tool-apis.md`, the `current-state.md` section).

1. **New files only** in the repo. Never edit `package.json`, `packs.ts`, `retrieve.ts` or any existing file; put the exact patch in your report.
2. No `ffd ship`, no app build, no full-suite run, no commit, no service start/stop.
3. Installing the package **outside the repo** (e.g. `npm i --prefix /tmp/notes-mcp apple-notes-mcp`) is allowed and expected. Do **not** add it to the repo's dependencies.
4. Never claim "ran live" for something you did not run against the real Notes app. "Compiled", "unit-tested", "ran live" are three different claims.
5. Running it against the owner's real notes needs his one-time macOS Automation (and possibly Full Disk Access) allow-click. **Ask for it in your report instead of assuming it.** A read-only `notes_list` on a throwaway note is the most you may attempt without that click.

## Verification ladder — go as far as you can, stop honestly

- **V0** — install in `/tmp`, print its version, and list its tools (`--help`, or its MCP `tools/list` through a 10-line stdio client using `@modelcontextprotocol/sdk`, which the repo already depends on).
- **V1** — create one throwaway note through it and read it back, inside the library's own storage if possible, so the owner's data is not touched.
- **V2** — read one real note body (needs the owner's click). If it is not granted, stop and say so; that is an acceptable result.
- **V3** — the adapter below compiles and its tests pass.
- **V4** — write the integrator patch and the vendoring recommendation with evidence.

## Deliverables (new files only)

- `src/app-tools/adapters/notes.ts` — a thin adapter that exposes the library behind **our** interface (`AppTool` from `src/app-tools/types.ts`), not the library's own tool list. Same policy as our packs: `notes_list`, `notes_read` (body), `notes_append`, `notes_update`, `notes_delete` (requires `confirm` equal to the note's own name, no bulk delete), read/write polarity correct, descriptions ≥3 sentences with an explicit negative, ≥2 owner-voice examples, ≥4 keywords. Because our `AppToolPlan` today only supports `{kind:'osascript'}` and `{kind:'steps'}`, add a third shape in your adapter file (`{kind:'cli', command, args}` or whatever fits) and document it in the report as the change `types.ts` needs.
- `test/app-tools/notes-adapter.test.ts` — pack invariants, selection for the owner's phrasings (`"summarise all my notes"`, `"give me a summary of all the notes"`, `"what did I write about the roof"`, `"show me my notes"`, `"add to my note about the roof: the plumber comes monday"`, `"delete the note called shopping list"` with `app:'Notes'`), non-selection for coding phrasings (`"write the failing test"`, `"add a retry to the sync loop"`, `"add a checks column to task_contracts"`), confirm-required refusals, and that no read-only tool can write.

## Questions your report must answer with evidence

1. Does it actually read note **bodies**, and from where (AppleScript, Shortcuts, or the Notes database)? What did you observe?
2. What runtime does it need (Node version, Python, a daemon)? Does it need Full Disk Access, Automation, or both? Which permissions prompt on first use?
3. Can it run **read-only**? Can we turn its write tools off?
4. Supply chain: is the code small enough to audit, does it phone home, any post-install script?
5. Vendoring vs dependency: your recommendation, one paragraph, with the tradeoff.

## Report format (short and factual)

- Session id; the files you created with `wc -l`; the exact commands and their `# tests / # pass / # fail`.
- The ladder rung you reached (V0–V4) and the evidence for each claim.
- The exact integrator patch (file, hunk, why).
- Anything you could not do and what you would need.

## Revision 2 (4 November 2026) — better candidates, and the traps that bite

Two independent research passes landed after this file was written. Read this before you choose.

Candidates, in the order worth trying:

1. `mgcrea/cupertino` (npm `@mgcrea/mcp-apple-notes`) — MIT, TypeScript, 1.36.1 (2026-11-03). Shared core is
   described as "the osascript boundary, TCC-aware errors, ro SQLite"; **writes are off per surface until you
   turn them on**, which is exactly our default; and the Full Disk Access grant is held by a signed app
   instead of the editor.
2. `sweetrb/apple-notes-mcp` (176★, MIT, npm `apple-notes-mcp`) — the one named above. Reads through
   AppleScript plus read-only `NoteStore.sqlite`; writes through AppleScript plus signed Shortcuts; it
   feature-detects the private SQLite columns per release.
3. `RhetTbull/macnotesapp` (273★, MIT, v0.8.3 2026-10-30, Python CLI `notes`) — the correctness reference in
   this space (same author as osxphotos). Do not add a Python toolchain to a Node app without saying so;
   the valuable part is its guardrails, so **adopt the behaviour, not the dependency**.

Measured traps you must handle, each with a source in the research report:

- `body` is the note's **HTML** and is read/write; `plaintext` is read-only; there is **no `save` command**
  anywhere in the Notes dictionary (`sdef /System/Applications/Notes.app`).
- **macOS 26 broke bulk reads**: bulk `body`/`plaintext` selectors return empty, so reads must iterate note
  by note (macnotesapp #62). About 1200 notes then takes ~30 s.
- Inline images are **base64 inside the body** — a 40 MB image makes a ~110 MB body, and the read cap is
  512 MB. Writing such a body back bakes the image placeholders in as text.
- Writes can be **silently lost**: Notes keeps changes in memory and writes NoteStore.sqlite on its own
  schedule, sometimes more than 20 s later, and at least once never (#86); a deleted folder can reappear
  30 s–1 h later (#89). A write tool must read back and say "not confirmed yet" rather than claim success.
- Attachments added through scripting can appear **twice** on Sequoia/Tahoe (#64, still open); a locked note
  can be listed but its text reads empty.
- `NoteStore.sqlite` holds protobufs under a private schema and needs Full Disk Access.

Add to your answer: which lane actually produced the body (AppleScript, Shortcuts, or SQLite), and what each
lane does on macOS 26 specifically.
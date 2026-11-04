## Shared context (read once)

FarFromDesk Local is a macOS app (Swift shell + Node/TypeScript backend). The owner talks to it from WhatsApp/Telegram; a small model picks **one reviewed tool** from a shortlist and the desktop driver executes it. The tool packs live in the repo and are the product's "API per app".

Work tree: `/private/tmp/ffd-pr` (branch `codex/local-desktop-work`, **shared with other sessions**).

Read before you write (read only, never edit):
- `src/app-tools/types.ts` — `AppTool`, `AppPack`, `AppToolArg`, `AppToolPlan`
- `src/app-tools/packs.ts` — the existing tools, `asStr`, `appleDate`, `appleDateParts`, `appleDateAssign`, and the AppleScript style to copy
- `src/app-tools/retrieve.ts` — how a tool is retrieved (tokenizer, IDF, `notFor`, pack scoping, read/write polarity)
- `src/app-tools/golden.ts` and `src/app-tools/golden-paraphrase.ts` — the phrasings the owner actually uses
- `docs/skills/ffd-local-development/references/current-state.md` — section "App tool packs: reviewed tools per app, and intent-to-tool retrieval"
- `docs/app-tool-apis.md` — the plan you are following

**Hard rules for this session**
1. Create **only new files**. Do not edit any existing file. If an existing file must change, write the exact patch into your final report; the integrator applies it.
2. Do not run `ffd ship`, do not build the app, do not run the full test suite, do not commit. Other sessions share this tree.
3. Do not start or stop any service, do not run `osascript` against the owner's real data unless the tool list below explicitly says a live probe is allowed. Compile checks (`osacompile`) are always allowed and required.
4. Never claim something ran live when it did not. "Compiles", "unit-tested", "ran live" are three different claims.

## Test contract (every new tool needs all of these)

The existing `test/app-tools.test.ts` (12 tests) must stay green. Run it after your changes.

## Your task: the Notes pack

The owner asked the companion: **"Give me summary of all the notes"**. It answered by dumping the accessibility labels of the visible Notes window ("On My Mac", "Tags", "Today", a couple of note titles) because it has no way to read note **content**. That is the failure you are closing. Notes must become a real API: list, read, append, update, delete — and a question about content must be answerable from content.

**Files you create (nothing else):**
- `src/app-tools/packs/notes.ts` — `export const NOTES_PACK: AppPack = { id:'notes', app:'Notes', bundleId:'com.apple.Notes', summary:<one line>, tools:[...] }` plus `export default NOTES_PACK;`
- `test/app-tools/notes.test.ts` — your tests

**Tools to build.** The names `notes_create_note` and `notes_find` already exist in `src/app-tools/packs.ts`; do **not** define them again. Your new names, all read-only unless stated:
- `notes_list` — list the owner's notes (name, folder, modified date, short body preview), newest first, with a limit arg. AppleScript, read-only.
- `notes_read` — read one note's **body** in full (or a bounded slice) by name/id; this is the tool that makes "summarise my notes" possible.
- `notes_append` — append text to an existing note after reading it (writes:true).
- `notes_update` — replace a note's body after reading the current one (writes:true).
- `notes_delete` — delete one named note, `writes:true`, with a required `confirm` argument that must equal the note's own name; refuse otherwise. Never delete a folder.

If two of these should be one tool with an `action` arg (the docs prefer consolidating near-duplicates under ~10 tools per namespace), do that instead and say why in your report.

## Notes AppleScript facts (measured; the dictionary is at `/tmp/sdef_Notes.xml`)

- The application class has element `note` (also `account`, `folder`): `every note`, `note "Name"`, `body`, `name`, `creation date`, `modification date`, `container`.
- `make new note at folder "X" with properties {name:"T", body:"B"}` works; `note.body` is writable.
- Folders: `every folder`, `folder "X"`, `notes of folder "X"`.
- Always escape with `asStr` and build dates with `appleDateAssign` (a `date "..."` literal is coerced by the Mac's own locale and has broken before).
- `/usr/bin/osascript -e <script>`; a missing Automation grant returns an error containing `-1743` / `not authorised`. The caller maps that to a clear "macOS is waiting for your permission" line, so your script only needs to fail honestly.
- Read cost: on a large library, cap the scan (e.g. first 300 notes) and say so in the description — an unbounded `every note` is slow.

## Safety and honesty

- `notes_delete` must read the note first, require the `confirm` argument to match exactly, and return the deleted note's name as proof. No bulk delete.
- Every write script must end by reading the changed note back and returning a line that proves the change (e.g. the new body length and first 40 characters). A tool that only says `true` is not acceptable.
- If a body is empty, say so in the result rather than returning an empty string the caller may misread as failure.
- The tool result is turned into an outcome sentence by `src/brain-device.ts`; that file is not yours, so make the AppleScript `return` values unambiguous and self-describing.

## Tests your file must contain (all green)

1. Pack invariants: unique `notes_`-prefixed snake_case names; every description ≥3 sentences containing "Use this when" and an explicit negative ("Do not use this when…"); every arg named and described; ≥2 examples in the owner's voice; ≥4 keywords; `writes` false for every read-only tool and true for every writing one; `notFor` phrases have ≥2 meaningful words.
2. `notes_list`/`notes_read`/`notes_append`/`notes_update`/`notes_delete` (whichever you build) are selected by `selectTools(...)` for the owner's real phrasings — at least: `"summarise all my notes"`, `"give me a summary of all the notes"`, `"what did I write about the roof"`, `"show me my notes"`, `"add to my note about the roof: the plumber comes monday"`, `"delete the note called shopping list"` (with `app:'Notes'`).
3. They are **not** selected for coding phrasings: `"write the failing test"`, `"add a retry to the sync loop"`, `"add a checks column to task_contracts"`, `"read the router contract code"`.
4. A date/arg validation test: a malformed argument is refused by `plan(args)` with a readable sentence (and the refusal is not an exception).
5. An `osacompile` compile test for every `kind:'osascript'` tool — same pattern as the existing `'every AppleScript tool compiles against its app dictionary'` test, using `spawnSync('/usr/bin/osacompile', ['-o', tmp + '.scpt', tmp + '.applescript'])` with realistic sample args.
6. A no-side-effect test: no read-only tool's script contains `make new|delete|set .*body|move|duplicate`.

## Commands to run and paste in your report

```
cd /private/tmp/ffd-pr
npx tsc --noEmit
npx tsx --test test/app-tools/notes.test.ts
npx tsx --test test/app-tools.test.ts
```

## What to report back (final message, short and factual)

- Session id and the two file paths you created, with `wc -l`.
- The exact commands above and their output counts (`# tests / # pass / # fail`).
- Which tools you built and one line on what each does.
- What you verified: compiled? unit-tested? **ran live?** (state the truth; a live run needs the owner's one-time Automation allow-click, so "not run live" is the expected honest answer).
- Anything you could not do, and the exact patch/report you would need the integrator to apply.

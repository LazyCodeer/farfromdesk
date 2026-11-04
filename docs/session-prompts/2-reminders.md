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

## Your task: the Reminders pack

Reminders is one of the owner's daily apps, and today the companion can only add one reminder and count what is open. Make it a real API: list, read, add, complete, update, delete.

**Files you create (nothing else):**
- `src/app-tools/packs/reminders.ts` — `export const REMINDERS_PACK: AppPack = { id:'reminders', app:'Reminders', bundleId:'com.apple.reminders', summary:<one line>, tools:[...] }` plus `export default REMINDERS_PACK;`
- `test/app-tools/reminders.test.ts` — your tests

**Existing names you must not redefine** (they live in `src/app-tools/packs.ts`): `reminders_add`, `reminders_list`. Your new names:
- `reminders_open` — list open reminders (name, list, due date, flagged), with an optional list filter and a limit; read-only.
- `reminders_read` — full detail of one reminder matched by its exact name (notes body, due date, priority, list); read-only.
- `reminders_complete` — mark one reminder complete (write), matched by exact name, `confirm` argument required; reads it back and returns the completed state as proof.
- `reminders_update` — change one reminder's due date / notes / priority / flag (write), matched by exact name; returns the new values.
- `reminders_delete` — delete one reminder (write), exact name match plus `confirm` equals that name; never `delete every reminder`.
- `reminders_lists` — the owner's lists with open counts; read-only. (Skip if it is too close to `reminders_open`; the docs prefer consolidating near-duplicates — say what you chose.)

## Reminders AppleScript facts (measured against the 7.0 dictionary)

- Classes are `account`, `list`, `reminder`. The app has only a `show` command; everything else is `make`/`set`/`delete` on properties.
- `make new reminder at end of reminders of list "X" with properties {name:"N", body:"B", due date:d1, remind me date:d1, priority:1, flagged:true}` — build every date with parts (`appleDateAssign`), never a `date "..."` literal.
- Open reminders: `reminders of l whose completed is false`. The default list is `default list`.
- Complete: `set completed of r to true`. Delete: `delete r` (never a `whose` clause that could match many).
- `/usr/bin/osascript -e <script>`; a missing Automation grant errors with `-1743` / `not authorised` — surface it honestly, the caller maps it to a permission message.
- Escape every string with `asStr`.

## Safety and honesty

- Every write tool requires a `confirm` argument that must equal the reminder's own name; refusal is a readable sentence, not a throw.
- No bulk operations. Never touch `completed` reminders except `reminders_read`.
- Every write script ends by reading the reminder back and returning something assertable (name, completed, due date) — not just `true`.
- Do not use the words `task`, `tasks`, `todo` anywhere in names, descriptions, examples or keywords: this product calls coding work "a task", and those words have already dragged `reminders_add` into `"add a checks column to task_contracts"`. Use "reminder".

## Tests your file must contain (all green)

1. Pack invariants: unique `reminders_`-prefixed snake_case names; descriptions ≥3 sentences with "Use this when" and an explicit negative; args described; ≥2 owner-voice examples; ≥4 keywords; `writes` correct; `notFor` phrases ≥2 meaningful words.
2. Selection by `selectTools(...)`: `"what reminders do i have open"`, `"anything I have to do today"`, `"show me my reminder about the plumber"`, `"mark buy milk as done"`, `"change the plumber reminder to friday"`, `"delete the reminder called buy milk confirm buy milk"` (with and without `app:'Reminders'` where sensible).
3. Not selected for: `"add a checks column to task_contracts"`, `"write the failing test"`, `"add a retry to the sync loop"`, `"create a new session for this"`.
4. Every writing tool's plan is refused without the right `confirm` value, with a readable sentence.
5. A writing tool whose script uses only `make new`/`set` on the target it just read; assert no script contains `delete every|remove every`.
6. `osacompile` compile test for every `kind:'osascript'` tool (same pattern as `'every AppleScript tool compiles against its app dictionary'` in `test/app-tools.test.ts`).

## Commands to run and paste in your report

```
cd /private/tmp/ffd-pr
npx tsc --noEmit
npx tsx --test test/app-tools/reminders.test.ts
npx tsx --test test/app-tools.test.ts
```

## What to report back (final message, short and factual)

- Session id, the two files with `wc -l`, the commands and their `# tests / # pass / # fail` counts.
- The tools you built, one line each.
- Compiled / unit-tested / **ran live** — state the truth for each; a live run needs the owner's one-time Automation allow-click, so "not run live" is expected.
- Gaps and any patch the integrator must apply.

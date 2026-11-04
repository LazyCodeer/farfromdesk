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

## Your task: the Calendar pack

Calendar is one of the owner's daily apps, and today the companion can only create one event and list an upcoming range. Make it a real API: find, read, create, update, delete.

**Files you create (nothing else):**
- `src/app-tools/packs/calendar.ts` — `export const CALENDAR_PACK: AppPack = { id:'calendar', app:'Calendar', bundleId:'com.apple.iCal', summary:<one line>, tools:[...] }` plus `export default CALENDAR_PACK;`
- `test/app-tools/calendar.test.ts` — your tests

**Existing names you must not redefine** (they live in `src/app-tools/packs.ts`): `calendar_create_event`, `calendar_list_events`. Your new names:
- `calendar_find_events` — search events by text and/or a date range across all calendars (summary, start, end, calendar name); read-only, bounded (cap the scan, say so in the description).
- `calendar_read_event` — one event's full detail (summary, start, end, location, notes, calendar, all-day, recurrence); read-only, matched by summary + start date.
- `calendar_update_event` — change the time, summary, or location of one event that this tool can identify exactly (write); reads it back and returns the new values. Refuse ambiguous matches.
- `calendar_delete_event` — delete one event (write), exact summary + start date, required `confirm` argument equal to the summary; **refuse** recurring events and events with attendees, and say why in the refusal. This is the riskiest tool here: deleting an invite can mail a cancellation to other people.

## Calendar AppleScript facts (measured against the 27.0 dictionary)

- `make new event at end of events of calendar "Home" with properties {summary:"S", start date:d1, end date:d2, location:"L", allday event:false}`; the target calendar may also be written as `calendar 1`.
- Read: `every event of c whose start date ≥ d1 and start date ≤ d2`, `summary of e`, `start date of e`, `end date of e`, `location of e`, `description of e`, `allday event of e`, `recurrence of e` (empty string when it does not repeat), `attendees of e`.
- Update: `set start date of e to d2` etc. Delete: `delete e`.
- **Always build dates from parts** with `appleDateAssign` and validate with `appleDateParts` — a `date "..."` literal is coerced by the Mac's own locale and has broken before. `appleDateParts` rejects impossible values.
- Escape with `asStr`. `/usr/bin/osascript -e <script>`; a missing Automation grant errors with `-1743` / `not authorised` — the caller maps it to a permission sentence.
- Timezone: the Mac's local zone. Say in the description that times are local, and never invent a timezone conversion.

## Safety and honesty

- Never send, invite, or mail: no `make new attendee`, no `send`, no mail. The description of every tool must contain an explicit negative about invites or mail where it is relevant.
- `calendar_delete_event` and `calendar_update_event` must first read the matching event and refuse anything ambiguous (0 or >1 match), anything recurring, and anything with attendees (delete case). Refusals are readable sentences, not throws.
- Every write script ends by reading the event back and returning the changed fields, not `true`.
- `calendar_find_events` must cap the number of events scanned and the number returned, and say so.

## Tests your file must contain (all green)

1. Pack invariants: unique `calendar_`-prefixed snake_case names; descriptions ≥3 sentences with "Use this when" and an explicit negative; args described; ≥2 owner-voice examples; ≥4 keywords; `writes` correct; `notFor` phrases ≥2 meaningful words.
2. Date building: no plan contains `date "`; `appleDateParts` rejects `"tomorrow at 5"` and an impossible time; the create/update scripts contain the part-built assignments.
3. Selection by `selectTools(...)`: `"what is on my calendar on friday"`, `"find the meeting with the team"`, `"move my dentist appointment to 6pm"`, `"delete the event called standup confirm standup"`, `"am I free tomorrow"` (with `app:'Calendar'`).
4. Not selected for: `"write the failing test"`, `"add a retry to the sync loop"`, `"where is the router contract code"`, `"create a new session for this"`.
5. Refusals: a delete without `confirm`, with a wrong `confirm`, an ambiguous match, and a recurring event each produce a readable refusal sentence; no send/invite verb appears in any script.
6. `osacompile` compile test for every `kind:'osascript'` tool (same pattern as `'every AppleScript tool compiles against its app dictionary'` in `test/app-tools.test.ts`).

## Commands to run and paste in your report

```
cd /private/tmp/ffd-pr
npx tsc --noEmit
npx tsx --test test/app-tools/calendar.test.ts
npx tsx --test test/app-tools.test.ts
```

## What to report back (final message, short and factual)

- Session id, the two files with `wc -l`, the commands and their `# tests / # pass / # fail` counts.
- The tools you built, one line each.
- Compiled / unit-tested / **ran live** — state the truth for each; a live run needs the owner's one-time Automation allow-click, so "not run live" is expected.
- Gaps and any patch the integrator must apply.

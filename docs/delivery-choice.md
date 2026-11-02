# Closed-app delivery choices, local implementation

Written 2026-11-03 in the `codex/local-desktop-work` worktree (PR #49). Owner-reported case: a
message was sent while the coordinator session's app was closed, and the only answer was
"Codex Desktop is closed. Queued; it answers when the app opens." The owner asked for the
companion to say what *is* available, offer the real options, and act on the one they pick.

## Why the message is held before it is submitted

Delivery to Codex Desktop goes through `codex queue --thread <id> --message <text>`. That command
has no list and no cancel (`codex queue --help`, codex-cli 0.160.0, checked on this machine), so a
message handed to Codex cannot be taken back. Offering a session choice after that point would run
the same task twice, in two sessions, on the same repository.

So the hold happens in the bridge, in the moment between accepting the owner's message and
submitting it, and exactly one answer is carried out.

## The card

Sent instead of the plain receipt when all of these hold: the owner's own message, the session is a
desktop app session (`execution-mode:<binding>` is `desktop`), that app is not running (fresh
`lsappinfo` probe, not a cached answer), and at least one other session can take the work now.

```
📴 Codex is closed, so I have not sent this to FarFromDesk coordinator setup yet.
- Held for FarFromDesk coordinator setup in project. Nothing has been sent to Codex Desktop yet.
- Running now: Claude Desktop, Muse Code.

1. Open Codex Desktop and send it there
2. Send it to Claude CLI · project
3. Keep it queued until Codex Desktop opens

Reply with a number or tap a button. If I get no answer in 15 minutes I send it to Codex Desktop as
usual, so nothing is lost.
```

WhatsApp gets the numbered text, Telegram gets inline buttons carrying the same numbered labels.
Both run through the existing message-choice path: owner authentication, single use, expiry,
one atomic claim, and no route into approval or slash-command handling.

| Answer | What happens |
| --- | --- |
| Open | `open -b com.openai.codex codex://threads/<id>` (or the Claude Desktop deep link), wait for the app, then release the hold and submit. The owner is told "Opening…", then "is open. Sending your message to <session> now", and the normal silence watchdog takes over. |
| Send it to X | The held copy is closed as `replaced` with the reason, the owner's exact words are queued to X, and the card says the closed app never received it, so it cannot run twice. |
| Keep it queued | The hold is released and the message goes to the original session as before. |

A choice that cannot be carried out (session disabled, other app now closed, the app did not start)
sends one plain line saying what failed and leaves the message held or released, never silently.

## Automatic endings

- The app opens by itself: the 60-second maintenance tick releases the hold, submits, and says so.
- Fifteen minutes pass with no answer: the hold is released and the message goes to the original
  session, which is the old behaviour. The card's buttons expire at the same moment.
- The request is replaced, cancelled or resolved: the hold is dropped.
- A contract, schedule or earlier choice already owns the dispatch: no hold is created at all.

## Work that is already inside the app queue

After submission the message is in Codex's own queue, so it cannot be moved. For that case the
five-minute silence escalation becomes a card with two real options, `Open Codex Desktop now` and
`Leave it queued`, and says plainly that the app can only be opened, not redirected. Opening it
never resubmits anything.

## Wording

When the brain is enabled, configured and allowed for status (`meta-brain-policy` plus a saved Meta
key), it writes the lead sentence from a closed fact sheet: state, app, session, folder, running
apps, offered alternatives, minutes. It is then validated: length, line count, no links, no
over-claim ("has been sent", "is now running", "has finished"), and it must name the app. Anything
that fails is dropped for the plain template line.

The bridge always writes the facts, the options, their numbering and the expiry. A model never
decides what a button does or how long the owner has. One model call is made per card; there is no
cache, so a burst of held messages makes a burst of calls.

## Files

New: `src/delivery-choice.ts`, `src/companion-voice.ts`, `test/delivery-choice.test.ts`, this
document. Changed: `src/router.ts` (receipt path, dispatch guard, hold settling, escalation card,
action answers), `src/message-options.ts` (action options), `src/meta-model.ts` (`compose`).

## Validation

- `test/delivery-choice.test.ts`: 11 tests covering the hold and its card, each of the three
  answers, the exact-once delivery for the moved case, the open sequence, expiry fallback, an app
  the owner opens by hand, the escalation card and its open-only answer, the brain lead and its
  fallback on an over-claim and on an API failure, and the case where nothing else is available.
- `tsc --noEmit` clean. Full backend suite 1696 tests, 1674 pass, 18 fail; the same suite on the
  unmodified tree has 17 failures, and the differing names are the flaky `combined F1/F2 guard`
  family under parallel load (they pass 7/7 in isolation, three runs).
- Not exercised: no real Codex or Claude app was opened by a test, no real phone answered a button,
  and the brain lead has never been produced by the real Meta model. The first live run is the
  owner's.

## Live test

1. Close Codex Desktop, keep Claude Desktop or Muse Code running, and send any short message.
   Expect a card naming what is running instead of the plain "is closed" line.
2. Answer `2`. Expect the chosen session to receive the message, and a line saying Codex never got
   it. Open Codex afterwards and confirm the task does not start there.
3. Repeat and answer `3`; expect the message to wait for Codex as before.
4. Repeat and answer `1`; expect "Opening…", then "is open. Sending your message…", and the session's
   answer afterwards.
5. Send a message while Codex is open; expect the ordinary receipt and no card.
6. With Codex closed, hold a message and open Codex by hand before answering; expect the held
   message to be sent with "is open now".
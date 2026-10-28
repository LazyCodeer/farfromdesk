# Message choices, local implementation

Implemented 2026-10-28 in the isolated `mac-screen-control-lab/work/farfromdesk-release` checkout, branch `codex/desktop-control-release`. The separate build-session checkout was inspected read-only and left untouched. Its last observed turn was complete. No production process, messaging client, credentials or private bridge state was accessed or changed.

## Producer contract

Authenticated POST `/api/session/reply` accepts the existing text/requestId/kind/eventId plus:

```json
{"options":{"choices":[{"id":"inspect","label":"Inspect first"},{"id":"continue","label":"Continue"}],"expiresInSeconds":900}}
```

`ffd reply-options REQUEST-ID progress` accepts `{text,options}` on stdin. The generated worker skill documents it. Existing `ffd reply`, text replies and API clients remain compatible. Both proxies and workers use their existing binding authentication. A request belonging to another binding is rejected. Reply text with choices is limited to 2000 characters; offer 2 to 6 labels up to 80 characters and stable IDs. Expiry defaults to 15 minutes, bounded from 30 seconds to 24 hours after queueing. No hidden action text or arbitrary callback command is accepted.

## Delivery and selection

Telegram Bot API inline keyboards use opaque 24-character random offer IDs and an index, comfortably below the 64-byte callback limit. Polling requests `callback_query` updates as well as messages. Callback identity, private chat, bot identity, saved owner, current channel, exact sent message, request and offer are checked. AnswerCallbackQuery acknowledges processing; it does not imply the selected work completed.

WhatsApp uses the current Baileys 7.0.0-rc14 linked-device transport, not the Cloud API. Installed protocol types contain button/interactive messages but that alone does not establish supported or reliable client rendering. Existing send path uses text/media. This increment deliberately sends numbered text through that path. The owner must use Reply on the offered message and type its number. Unquoted numbers keep their existing behavior. Owner-only groups retain separate owner and destination checks, in addition to existing transport membership checks. Native WhatsApp buttons have NOT been verified and are NOT implemented.

SQLite persists offer, original request/session, owner, destination, exact outbound message reference, expiry, selected ID and response ID. Delivery must be confirmed sent, not queued/sending/uncertain. Consumption and queueing happen in one transaction; failure rolls back. A repeated same selection cannot queue another request, including after restart. A conflicting second selection is rejected. Paused bindings, replaced/cancelled/reviewed requests, expired offers, changed owner or channel cannot accept an answer. Deleting retained outbound messages cascades their offer rows.

Selection bypasses all slash-command and native approval handlers. The new request contains the offered ID/label as JSON, original request reference, and explicit scope/permission distinction. The persisted response linkage records provenance. A choice can convey the owner's offered answer, not approve a native permission or create new authority. Normal typed replies remain supported.

## Validation and remaining install work

TypeScript build and focused tests cover structured CLI/API payloads, cross-binding rejection, Telegram mocked sendMessage keyboards and callbacks, forged/wrong-owner/wrong-message callbacks, idempotency, expiry, changed channel/account, withdrawn requests, uncertain delivery, rollback on queue failure, real SQLite reopen, approval-handler isolation, WhatsApp numbered/group paths, and legacy reply/routing/audit paths.

These are local automated tests. No real Telegram callback or WhatsApp rendering was tested. No build was installed, no production restart occurred, and no native permission was changed. Next integration step is an authorized test build followed by one fresh offer per app, quoted-number selection in WhatsApp, tap and repeated tap in Telegram, plus an expired offer. Device-level display/interaction evidence remains required.

## Integration files

New: `src/message-options.ts`, `test/message-options.test.ts`, this document.
Changed: `src/store.ts`, `src/router.ts`, `src/telegram.ts`, `src/request-events.ts`, `src/ffd.ts`, `src/server.ts`, `test/ffd.test.ts`, `test/telegram.test.ts`, `test/http-hooks.test.ts`.

Preserve unrelated uncommitted owner-view and LiveKit work. In `src/server.ts`, only the session reply call's `options:d.options` addition belongs to this task; other pending changes belong to earlier remote-desktop work. Do not copy the entire checkout over the newer build-session project. Merge these changes against its routing implementation and rerun focused checks before packaging.


## Integration into the newer combined local build

Merged by individual changes into `codex/phone-mac-preview`, based on main after
PR 7. The newer Brain, owner-reply policy, direct routing, file delivery and phone
remote work are retained. Both worker and proxy generated skills document
`reply-options`. Options are included in reply identity; identical text with new
choices is not accidentally swallowed by text-only coordinator deduplication.
Relay-only proxy replies reject options explicitly because their payload is not
sent directly to the owner. Ask the owner-facing proxy to offer those choices.

Combined local validation: 519 backend tests pass, two skipped; TypeScript build
passes. Flutter's same UI build compiles with the message-capable backend.
No real Telegram/WhatsApp delivery is claimed by these checks.

### Live test entry point

After a test bridge has an authorized connected account and an existing bound
session request, use that session's generated ffd command (not another session's
credentials). Supply this JSON to `ffd reply-options REQUEST-ID progress`:

```json
{"text":"Which harmless test should we run next?","options":{"choices":[{"id":"inspect","label":"Inspect the test window"},{"id":"wait","label":"Wait for me"}],"expiresInSeconds":900}}
```

On Telegram, tap one button, then tap it again and confirm only one follow-up is
created. On WhatsApp, Reply to the offered message and type `1` or `2`; native
WhatsApp buttons are not implemented. A second conflicting answer should be
refused. Repeat with expiry set to 30 seconds and verify it refuses a late answer.
Neither choice grants native permission or authorizes unrelated work.

The isolated Phone Test state is not paired with WhatsApp or Telegram. Real
message display requires a connected test channel; do not copy account files or
start a second client using the owner's already active bot/account.

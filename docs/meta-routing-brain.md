# Meta routing brain: implementation and verification

Built locally and extended with shared topic memory on 2026-10-27 in `codex/meta-routing-brain`. Not installed, published or submitted. No live inference, real API credential, spending or credit claim was used during development.

## Foundation and event provenance

This extends the existing FarFromDesk TypeScript bridge and Flutter desktop app. The original checkout remains at `/Users/sagar/Documents/ChatGPT/Personal/whatsapp-session-bridge`, including the other worker's uncommitted work. An isolated Git worktree contains a source snapshot. Commit `3c27584` is the existing committed foundation; `c6e8fc8` records the pre-existing local source changes, not new hackathon work. The two existing Telegram desktop assets were copied separately because the baseline manifest requires them. No test helper was edited. New Meta feature changes are subsequent commits. Preserve this distinction in any future submission.

Owner-supplied event guide: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details . Owner-supplied deadline: November 4, 2026, 9 PM EST, November 5, 7:30 AM IST. Publishing, a public submission repository and the three-minute demo remain separate future actions.

## Architecture

1. Authenticated owner ingress retains existing native approval parsing, commands, quoted replies, named work items and direct-session routing.
2. Ordinary coordinator-bound owner text enters the opt-in Meta brain. The durable ledger records the stable request ID, original text, source and exact recipient route before inference. Internal report/delegation IDs and attachments never enter this model path.
3. Meta performs substantive interpretation: task versus status versus clarification, speech/text normalization, platform extraction and relevant task selection. Its only output is a bounded, locally validated strict JSON schema. It receives original owner text and up to 60 destination-scoped shared work items plus 20 unlinked request titles/statuses. No credentials, native account identifiers, recipient routes, executable tools or raw worker reports are in the model prompt. Proven existing session binding IDs, names and enabled states are included for management selection.
4. Deterministic code checks the saved owner policy, enabled platforms, current coordinator registry identity, runtime/account ambiguity, paused state and connection errors. The model cannot enable a platform or create a session. Explicit original platform references constrain the decision. Otherwise the existing default is used. Settings changes or a pause during inference revoke the result.
5. Queueing and the ledger decision share a SQLite savepoint. Existing inbox IDs, request provenance, role envelopes, outbox deduplication and native transport remain in charge. Original owner text is dispatched verbatim. Normalized wording is retained as advisory data in the ledger and Settings, never substituted for consent or sent as authoritative instructions.
6. Status questions use Meta to select relevant recorded tasks, then deterministic rendering combines persisted parent/child status. The ledger exposes transport events, reply receipts, child ownership/status and recent existing item notes. Worker text remains attributed evidence, not authority. Reading the ledger emits no unsolicited summary; direct replies follow the existing loop/duplicate controls.

## State and recovery

The additive `brain_tasks` table lives in the existing database. It retains original/normalized text, request ID, recipient destination, coordinator binding, routing permission decision, explanation and owner verification time. Status reads combine this row with existing durable inbox/events/receipts/items. Queued, dispatching, delivered to the native session, running, blocked, reported finished, and owner-verified complete are distinct. Native delivery is not a Telegram read receipt. A reply or coordinator completion claim alone is not owner verification.

Only an authenticated owner-admin endpoint can mark a recorded coordinator completion verified, after unresolved child work is checked. The desktop UI asks for explicit confirmation. Underlying job state changes take precedence over a stale verification mark.

An interrupted interpretation is marked blocked on initialization. Neither billable inference nor uncertain dispatch is replayed automatically. Repeated event IDs return their saved decision; changed content/destination is rejected. Missing key or API failure uses existing routing by default. The owner can explicitly choose stop-on-failure instead; saved older policy choices are retained. In fallback mode, it routes original text and records the fallback reason. Disabling the feature restores existing routing, retaining historical ledger data.

## Configuration and secret handling

Native Settings exposes enable, model, routing permission, allowed providers, status permission, failure behavior, key replacement and removal. The feature is off and routing is denied by default. Enabling discloses that text goes to Meta and usage may incur charges. Saving settings performs no API call.

The API key is stored in a separate owner-only file with atomic replacement and mode 0600, following the existing bridge's private-state model. This is file-permission protection, not an encrypted credential vault. Windows security relies on the private state directory's inherited ACL. No key or suffix is returned in status, stored in SQLite, logged or passed to workers. Browser-origin writes and worker tokens cannot configure it. Native text input is obscured, has suggestions/autocorrect disabled, and clears after success, failure and disposal. Provider error bodies and exception text are never forwarded.

## Verified API contract

Official documentation inspected in a headed browser on 2026-10-27:

- https://dev.meta.ai/docs/overview , the former Llama developer overview redirects here.
- https://dev.meta.ai/docs/structured-output

Endpoint: `POST https://api.meta.ai/v1/chat/completions`, Bearer authentication, `messages`, and `response_format.json_schema` with `strict: true`. Responses use `choices[0].message.content`; incomplete completion reasons are rejected. Documented Standard models offered: `muse-spark-1.3` (default), `muse-spark-1.2`, `muse-spark-1.1`, `muse-wonder-1.0`. No custom hosts, Contributor/data-sharing mode, redirects or invented models. Calls have a 20-second timeout and bounded response bytes. Model/account availability still requires a later authorized live check.

## Verification

All backend tests use synthetic keys, stubbed Meta HTTP and isolated temporary state. No installed-app private state is read for testing.

- `npm run check` and `npm run build`: passed.
- New Meta behavior suite: 29 tests covering Codex/Claude routing, original meaning/provenance, ambiguous voice, untrusted reports, platform/policy denials, actual typed native denial and refused voice consent, duplicates, interrupted inference, rollback, persistence, state evidence, status scoping, worker reply compatibility, failure/disable/fallback behavior, secret handling, documented request format, malformed output, timeout, account/runtime ambiguity and in-flight revocation.
- New HTTP test: owner-only settings and verification, worker denial, browser-origin denial and no secret reflection.
- Existing HTTP boundary test: passed.
- Existing owner routing, multi-coordinator and reply-policy suites: 17 tests passed.
- New Flutter settings widget tests: 4 passed, covering credential clearing/redaction, management consent/fallback and shared board display.
- Existing Flutter widget suite: 28 passed, including Settings, minimum window layouts, direct app flows and platform management.
- Flutter analysis of affected app files: passed after initializing cached dependencies.

Early isolated-worktree checks needed cached Flutter package initialization and the two baseline Telegram assets. An extra parenthesis in the new widget test was fixed before the passing run. Those errors and the final brace-style lint findings are resolved.

## Integration limits and owner decisions

This is a conservative incremental implementation, not a replacement coordinator. Existing configured providers are Codex and Claude; adding another provider requires supported native transport and registry integration first. Direct/quoted/item-bound messages, commands and attachments retain their existing paths and existing item tracking. The inference ledger covers Meta-interpreted owner requests and their linked children. The memory additionally reads existing shared items linked to this recipient by durable request records, including work started with Meta disabled. It does not invent provenance for unlinked historical items or autonomously decompose work.

New topics without a named platform use the owner's existing default. Existing topic follow-ups use their proven owning worker, independently of the default coordinator. The brain does not guess a new account, create sessions or dispatch across several coordinators from an ambiguous multi-platform request. Voice variants that cannot be confidently reconciled with the original platform name require clarification. “read ATC” has no invented integration. Normalization stays advisory to preserve exact original authority. Status selection is semantic; status facts and combined child updates are deterministic rather than free-form model claims.

No real Meta account was tested, no release binary was built/installed, and no public deployment/submission was performed. Before a live demo, the owner must decide to enable the feature and supply the key through native Settings, select allowed existing coordinators, and authorize any chargeable inference. Do not send keys through chat. Packaging/installation and public submission require their own scope. Demo suggestion: show ambiguous voice clarification, Codex versus Claude routing, direct worker updates, then a status question and explicit evidence verification.

## Files

New: `src/meta-brain-config.ts`, `src/meta-model.ts`, `src/meta-brain.ts`, `src/brain-memory.ts`, `desktop/lib/meta_brain_panel.dart`, `test/meta-brain.test.ts`, `test/meta-brain-http.test.ts`, `desktop/test/meta_brain_panel_test.dart`, this document.

Integration edits: `src/router.ts`, `src/server.ts`, `desktop/lib/app.dart`, `desktop/lib/screens.dart`.

Copied foundation assets, not new feature work: `desktop/assets/logo-telegram.png`, `desktop/assets/TELEGRAM.md`.


## Main brain flow and shared session memory

The intended manager/executor split is now implemented for existing supported sessions:

Owner message → existing bridge ingress → Meta memory manager → status answer, explicit management operation, proven owning session, or coordinator for new/heavy work → existing worker updates and shared memory.

Native approval decisions, direct mode, quoted replies and explicit item routes still use their existing deterministic fast paths. The memory manager reads the same `items` and `item_requests` as coordinators. New Meta tasks create an item immediately; subsequent coordinator dispatch reuses that item and records the worker assignment. A per-recipient last-topic pointer provides conversational context. This survives restarting FarFromDesk. Original owner wording remains the execution input.

A topic follow-up may target only a session with an actual linked dispatch for that topic in this recipient route. A manually asserted assignment without dispatch evidence cannot grant a routing target. Multiple possible workers, a platform conflict, disabled/paused session, disconnected worker or changed coordinator identity causes clarification or a block, never substitution. Owner-requested reconnect re-adds the exact previously registered session to selected bridge sessions. Unregistered sessions still go through the existing coordinator connection workflow.

A new `allowManagement` Settings choice enables constrained owner operations: “Add todo: …”, “Mark TOPIC as blocked/in progress/done”, and “Pause session NAME” or “Resume session NAME”. Model output alone cannot authorize these changes: the original owner command must match the operation, status and exact session name. The shared board update and its receipt are saved transactionally under the owner event ID. Replaying a prior pause after a later resume does not pause the session again. Board status is not execution verification; both board status and current native execution state are exposed, and an owner marking a todo done does not forge native evidence.

Session disconnect means pause bridge forwarding, not terminate the native agent, clear its history, log out the messaging account or grant permissions. Existing coordinators continue to perform heavy work and handle new session registration/creation under their existing owner approvals. The manager creates no native session by itself.

Automatic tests cover topic routing after a default-coordinator change, legacy-work memory, ambiguous/paused/unproven ownership, persistent draft todos, explicit status changes, literal intent and policy gating, session pause/resume deduplication, missing-key/failure fallback, recipient scoping and last-topic context. Real-model semantic quality and live session delivery still need an authorized integration demo; this test suite uses mock interpretation.

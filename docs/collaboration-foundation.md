# Collaboration claim foundation

This is an internal, **opt-in prototype**, not the finished collaboration
feature. No production path enables the adapter or exposes a handoff endpoint.
The prototype stages handoffs only between verified managed CLI connections;
Desktop and channel sessions are not supported. It does not renew claims
automatically, inspect Collaboration memory, call Meta, validate drift or run
a proof check. Do not present it as enforcing one-session execution until
every dispatch and handoff path uses the same guard.

In an explicitly enabled test router, a trusted adapter stages a handoff during
the source coordinator's managed turn. It waits for observed source completion,
binds the owner's exact contract and session identities, and claims the item in
the same transaction as creating the target's dispatch attempt. Authorization
is checked again after asynchronous readiness and immediately before managed
submission. An interrupted dispatched job is uncertain and is never replayed.
The exact claim is retired on a confirmed pre-submission failure; a durable
marker set immediately before provider handoff keeps the claim if an outcome
could be uncertain, even if the provider throws a misleading error.
After restart, the adapter retires only an exact claimed attempt with a
persisted pre-submission marker. Missing or older markers, mismatched claims,
and attempts that crossed the provider boundary remain uncertain.
The source owner request must remain open; if it closes or changes, the staged
child fails closed. Other queued work on the item waits for the claim to finish.

The ledger records explicit claims, renewals, releases and handoff summaries in
SQLite. A claim is bound to one item, owner, destination, root request, exact
approved contract ID/revision/hash and session fingerprint. Claims carry a
generation and random fencing token. An explicit acquisition can replace an
expired idle claim, but never while the bridge can see a linked queued,
dispatched, submitted or uncertain job. Handoffs and releases also refuse while
such work exists. A handoff records the contract identity and sender/recipient;
it neither starts work nor claims the recipient automatically. Summaries are
untrusted local data and drift is always `not_checked`.

The authority callbacks are an internal trust boundary, not a user-supplied
API. They must synchronously read current owner-approved role authorization on
the same SQLite connection. The ledger additionally checks current owner,
destination, item provenance and exact session identity. F3's approved-contract
interface is still changing; no production role adapter exists.

The active-work check follows the bridge's bounded request/item ancestry; it
cannot discover work that was never recorded or correctly linked to the item.
Before enabling F5, ensure all native, managed, channel, option, scheduled,
report and delegated paths persist links and use the same guard, renew leases
during long active turns, and fail closed after restart, owner/session/contract
changes, or uncertain delivery. A router without the prototype enabled cannot
enforce its claims; the test adapter cannot protect concurrent external work.

Remaining work includes a production contract and role adapter, a scoped
owner-visible timeline and brief integration, session roles from approved
Collaboration memory, an actual Wonder drift check grounded in the contract,
and a single run-bound proof check after the final handoff. Test a complete
plan/build/review flow and concurrent claimants before considering release.

## Managed Claude CLI correlation

Claude SDK and stdio results do not yet authorize an F5 source yield or target
claim release. Both adapters serialize calls within one runtime instance, but
the current stdio adapter accepts a result for whichever turn is pending, and
the SDK adapter accepts results without a session ID or without a matching
request identifier. Synthetic protocol fixtures reproduced both cases; they
did not contact a provider or use a real session.

The installed SDK 0.3.310 declarations allow a client UUID on a structured
streamed user message and describe optional result `user_message_uuid` and
`user_message_uuids` fields. A future adapter could persist a unique message
UUID with the exact bridge attempt, then require the same session and UUID on
the result. It must fail closed on missing, mismatched or ambiguous fields,
mixed or queued turns, interrupted runs, duplicate results and uncertain
transport outcomes. Older producers may omit correlation fields. The actual
CLI's echo behavior and event ordering have not been verified by a live call.

Matching a UUID would identify a result; it would not prove exclusive control
of the native session. Two independent synthetic SDK instances can run the
same session concurrently. A bridge-local lock and one-time live-process scan
cannot prevent another process from starting that session afterward. A future
implementation needs a defensible cross-process ownership boundary and
evidence that relevant background work has stopped. Continue holding the claim
when these facts are unavailable, including after restart.

## Claude Desktop handoff blocker

The existing signals do not establish that the exact Claude Desktop turn has
stopped, so this prototype rejects Desktop as both source and target:

- `NativeAgents.requestStatus` returns no observation for Claude. The Codex
  observer reads a native thread and uniquely matches the request envelope;
  that implementation is not a Claude Desktop status API.
- `native/desktop_sync.py` sends a frame to the discovered Claude socket and
  returns `submitted` with `deliveryConfirmed: false`. This is neither a turn
  completion receipt nor proof the frame was processed. The helper's message
  ID is not linked to a verified provider turn by the bridge.
- A Claude `Stop` hook can arrive without an exact request or turn ID. The
  existing hook path holds unlinked updates, and even linked updates are output
  evidence, not a trusted completion event for an exact claimed attempt. A
  final reply also changes request status without proving the provider has
  stopped running. Neither signal is sufficient to transfer exclusivity.

Supporting Desktop requires a reliable, request-bound provider lifecycle signal
with exact session, connection and attempt provenance; persisted correlation
and recovery rules; and final-boundary claim checks for all competing dispatch
paths. Offline tests must cover concurrent turns, lost/duplicate/stale events,
session replacement, owner and contract changes, and restart on both sides of
submission. An external Desktop session may also receive work outside the
bridge, so completion of one request alone cannot prove global exclusivity.
Until these conditions are established, keep the managed-only gate and never
infer completion from a socket acknowledgement, reply or elapsed time.

### Candidate events and test-only protocol

[Claude's hooks documentation](https://code.claude.com/docs/en/hooks.md#userpromptsubmit)
states that `UserPromptSubmit` also runs for cross-session messages and supplies
the prompt; common hook fields document `prompt_id`. The
[telemetry documentation](https://code.claude.com/docs/en/monitoring-usage.md#hook-execution-complete-event)
documents `prompt.id`, `session.id`, per-process sequence, and a
`hook_execution_complete` event containing hook counts. This makes a future
correlation adapter worth investigating, but the documented socket message ID
is not tied to `prompt_id`. Matching text, a request ID in the prompt, or a
nonce visible in the prompt does not prove which socket frame caused it.

The fixture `test/fixtures/desktop-lifecycle-model.mts` explores a deliberately
hypothetical protocol. It assumes evidence the documented interfaces do **not**
currently provide: authenticated frame-to-prompt origin, a shared identifier
for a particular Stop invocation and its completed hook chain, a complete
ordered event stream, and an exclusive provider fence against new or external
work. In that model the exact owner, destination, contract revision and hash,
session identity, request and attempt must still match; Stop must have known
empty background and scheduled work, and the matching hook chain must have no
blocking, cancelled, failed or continuation feedback. These assumptions are
test fixtures, not observations or a production authorization mechanism.

In particular, `num_blocking=0` alone is insufficient: a Stop hook can return
`additionalContext` and continue the conversation; cancelled or missing events
and unknown background task state must remain uncertain. Some telemetry fields
have documented minimum versions, and exports can arrive late or fail. A
Stop hook fires before the entire hook chain has settled. Interruptions and API
errors also need separate handling. A delayed telemetry record cannot establish
that another prompt has not started before the handoff.

Any real experiment requires explicit opt-in to hooks and telemetry, a scoped
authenticated local collector and a privacy review. Prompt hooks receive the
full prompt; telemetry can include account email and workspace paths, and
optional settings can expose prompts or tool content. Do not enable verbose
prompt/tool logging or change the user's existing Claude configuration for
this prototype. The fixture runs entirely offline and does not alter live state.

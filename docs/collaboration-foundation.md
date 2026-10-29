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

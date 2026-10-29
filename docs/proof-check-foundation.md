# Proof check foundation

This is an internal foundation, not a finished user-facing proof check. It is not
wired to the router, Meta, screenshots, test runners, PR APIs, messages, or task
contracts. With no independently verified evidence source, results are
`unverified`. A session's completion report, claimed test output, screenshot
URL, or PR link alone cannot produce a pass or fail.

## Trust boundary

`ProofChecks` accepts an opaque evidence reference and delegates its resolution
only to trusted bridge code. An evidence adapter must independently verify the
source, exact approved contract and check, root request and item, paired owner
and destination, bound session and run attempt, target repository and exact
project revision. It must not accept the session's own assertion as an
independently verified outcome. In particular, `request_events.source_commit`
identifies the FarFromDesk build, not the user's project revision.

The synchronous `current` adapter must read the authoritative paired-owner,
approved-contract, item, session, attempt and target information from the same
SQLite connection used by `ProofChecks`. Final state and one-correction claims
are checked and persisted in a transaction with no intervening await. An
integration must revalidate again immediately before delivering a result or
dispatching a correction, including after any native readiness wait. It must
not trust caller-provided owner IDs or a previously paired destination.

Only a fresh, independently verified observation for an exact approved check
and its explicit owner-approved evidence binding can supply pass or fail.
F3 currently has no such bindings, so its checks stay unverified. A bounded
Wonder evaluator sees only coarse categories and verified source/status codes;
it may confirm or downgrade a verified pass, but cannot make a self-report,
unbound result or missing evidence into proof. An independently verified failure
remains a failure. Observations and result views expire after 30 minutes.
Checks without sufficient evidence are unverified. Records store check IDs,
verdicts and evidence hashes, not source contents. An evaluation ID makes a
request idempotent; a new ID permits an explicit recheck when evidence arrives.
One correction claim per approved contract revision is persisted before any
dispatch and is never automatically replayed. A newer evaluation, even while
still running, makes an older failure non-actionable. Interrupted evaluations
are not replayed automatically; an explicit new evaluation ID is required.

## Integration still required

1. Map the approved, immutable F3 contract and check IDs to a verified task
   attempt and current target project revision. Do not infer the latter from a
   session reply or from FarFromDesk's own source commit.
2. Add an explicit owner-approved evidence binding to each check, then implement
   narrowly scoped adapters that verify test results and linked PR head/check
   state against that binding. A generic successful CI run is not proof of an
   unrelated requirement; categories alone do not establish semantics.
3. Integrate the Wonder adapter only over those independently verified signals.
   Treat model output and task/session text as untrusted. Its signal evaluator
   is intentionally coarse and cannot understand an actual screenshot or log.
4. `assessProofVision` is an unwired advisory-only helper, tested with a fake
   fetcher. It takes a separately reviewed check excerpt and a captured PNG
   only after a trusted adapter verifies an explicit Meta-use consent and a
   request/check/attempt-bound, selected nonsensitive window. The full approved
   check may contain credentials and is never uploaded; only an exact excerpt
   separately reviewed by the owner and bound to that check may be sent. It rechecks the
   owner and authorization immediately before network I/O and after inference,
   checks the PNG hash, and limits image dimensions and bytes. Its result is
   *not* an independently verified pass or fail. Existing capture artifacts do
   not contain the required provenance and consent, so there is no built-in
   adapter or automatic upload. Add provenance and an owner-authorized adapter
   while respecting Mac-control and Screen Recording settings; never add
   implicit full-screen capture or security-prompt interaction.
5. Deliver a scoped result and, for an actual failed check, wire the existing
   one-correction claim through the shared dispatch authorization guard. Ensure
   failures, timeouts, interrupted sends and reruns never cause duplicate work.
6. Independently review the combined F1/F2/F3/F4 changes, including the
   verified good and deliberately broken task scenarios from the feature plan.

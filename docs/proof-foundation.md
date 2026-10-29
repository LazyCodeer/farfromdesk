# Proof foundation

This code is not yet connected to task contracts or user-visible reporting.
Missing, stale, contradictory, untrusted or unavailable evidence remains
unverified. A coding session's own report is not independent evidence.

## GitHub check evidence

The optional public GitHub adapter supports the narrow, owner-approved
criterion `GitHub check <exact check name> passed`. The stable binding contains
the exact public repository and check name. It does not establish unrelated
natural-language requirements from a green check.

The actual check-run ID is established after the run, not approved again per
occurrence. Before using the ID, trusted bridge-owned provenance must prove that
it belongs to the exact owner, contract, task, attempt and target revision.
There is no such provenance adapter or F3 binding UI yet, so production code
must not wire this adapter until those pieces exist. A session's assertion,
client-supplied ID, matching commit alone, or a callback that blindly returns
true is not trusted provenance. Private or unavailable checks stay unverified.

The adapter calls only the fixed GitHub API origin, sends no credentials,
rejects redirects and bounds response size and time. It validates the unique
run ID, exact check name, target head and completion time. Only GitHub's
`success` and `failure` conclusions map to evidence; other states remain
unverified. Evidence timestamps must come from a trusted source event, not the
time it was fetched or a model/session claim. Contradictory or stale evidence
cannot trigger a correction.

## Vision advisory

The screenshot helper is advisory only. It needs existing trusted provenance
for the exact selected nonsensitive capture, separate owner consent for Meta,
and a separately owner-reviewed excerpt tied to the approved check. It does
not capture screens or create proof. Credential-pattern filters are a defense
in depth and cannot establish that text or an image contains no secrets.
Production must not wire it until capture provenance and consent are available.

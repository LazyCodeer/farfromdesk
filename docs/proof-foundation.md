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
for the exact selected nonsensitive capture and owner consent for Meta. It does
not capture screens or create proof. It derives a fixed prompt only for a
narrow allowlist of exact, already-approved button-color and light/dark-mode
checks. It never copies other check text; unsupported checks remain unverified
without asking the owner to approve a new excerpt.

Before upload, the helper strips PNG text, EXIF, timestamp and resolution
metadata and normalizes fully transparent color channels.
It decodes and re-encodes supported pixels using a fixed filter and compression
strategy instead of forwarding the source's DEFLATE padding or filter choices.
It fails
closed on malformed data, custom color profiles, animation, interlacing,
indexed-color images, suggested true-color palettes, grayscale/RGB color-key
transparency, oversized canonical output and unsupported formats. It binds authorization to both the
original and sanitized image hashes and the sanitization policy. This does not
guarantee removal of data embedded in visible pixels or rendering-related color
values. Production must not wire this until trusted capture
provenance, nonsensitive-window selection and consent are available.

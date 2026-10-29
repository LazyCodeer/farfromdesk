# Proof foundation

The independent evidence engine is not yet connected to production sources.
For an approved F3 root task with a final reply or explicit completion outcome,
the bridge can queue a short owner-facing report: it labels the session's excerpt and an
optional mentioned GitHub PR as unverified and lists each approved check that
needs confirmation. This uses the existing F3 owner/session/delivery guard;
it neither captures or uploads screenshots nor starts corrections. A final
without an outcome does not establish completion. It does not
evaluate the content of the PR, establish whether tests ran, or mark a check
passed or failed. Missing, stale, contradictory, untrusted or unavailable
evidence remains unverified. A session's own report is not independent evidence.

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

## Project snapshot prototype

`ProofProjectSnapshots` is disabled: it reads no Git data and never records
or verifies a snapshot. Any records from earlier experiments are untrusted.
Git commands at a pathname can observe a different repository that was swapped
in and restored between directory checks. Git configuration may read outside
the project or run filters; status can overlook assume-unchanged or ignored
files. An attempt marked dispatched may already have been submitted, so it does
not establish the pre-submission boundary either.

A future design needs a bridge-controlled, stable, immutable project observation
with strictly contained reads, captured at an awaited lifecycle boundary before
native submission and revalidated against the approved F3 owner, session and
attempt. It also needs a trustworthy binding of the target repository, commit,
check and unique run to that attempt. Inode checks, local origin, a clean Git
status or a matching GitHub head alone cannot establish those facts. Until such
a design is independently reviewed, checks remain unverified.

On the tested macOS host, Git could not traverse inherited directory handles
through `/dev/fd`. An `fchdir` experiment kept an opened Git directory through a
whole-directory rename, but a ref inside that directory could still be changed
and restored without changing its directory inode. A directory handle alone
therefore does not make the observed commit immutable. A strict Git read
allowlist also failed to start Git in the synthetic probe; it is not yet a
usable containment mechanism.

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
transparency, oversized canonical output and unsupported formats. Gamma and
chromaticity chunks are accepted only at the exact standard sRGB values;
other values are rejected, not stripped, to avoid changing color interpretation.
Accepted images without these chunks are not assigned a color profile. It binds authorization to both the
original and sanitized image hashes and the sanitization policy. This does not
guarantee removal of data embedded in visible pixels or rendering-related color
values. Production must not wire this until trusted capture
provenance, nonsensitive-window selection and consent are available.

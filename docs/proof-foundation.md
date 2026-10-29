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

## Project snapshot prototype

`ProofProjectSnapshots` is an unwired local prototype stacked on F3. It checks
the approved F3 contract, owner, destination, binding, item and dispatch attempt
against the bridge database, then reads Git at the exact canonical bound project
root. It records before and after HEAD, local origin, project and Git directory
identity, and whether Git reports tracked or untracked changes. It rejects
linked worktrees, submodules, non-GitHub origins and paths that cannot be
validated. The post snapshot must match the pre snapshot's directory and origin.
Owner or session changes during capture prevent recording. Unsupported cases
remain unavailable, rather than stopping or rerouting the task.

These snapshots do not prove an owner approved a repository or a check, link a
GitHub check run to this attempt, or prove a commit was produced by the task.
Git status excludes ignored files; a clean result is not a guarantee that all
files match the commit or that a test passed. The read is not an atomic file
system snapshot and must be revalidated when used. The local origin is not a
verified remote identity. An attempt marked dispatched can already have been
submitted, so calling the prototype alone does not establish that the before
read preceded native submission. Production must capture at an awaited
pre-submission lifecycle boundary and revalidate authorization before dispatch.
This prototype is not called from production, does not access GitHub, and needs
independent security review of Git execution and filesystem races before wiring.
It currently supports macOS only. Git runs in a sandbox that denies network,
writes and other child executables, and warnings or errors reject the capture:
even a zero exit status may accompany a failed repository clean filter. The
sandbox does not yet confine reads caused by Git configuration includes, so
its read scope must also be fixed before production use.
No unique check-run association can be derived from these snapshots alone;
ambiguous, unavailable or unlinked checks remain unverified.

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

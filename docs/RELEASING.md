# FarFromDesk releases and Actions cost controls

## Routine changes

`.github/workflows/desktop-checks.yml` runs one Ubuntu job for code changes on main and pull requests. It checks TypeScript, portable routing/security regressions, publication/installer tests, and Flutter analysis/widget tests. It does not compile desktop apps or speech tools. Documentation-only changes skip desktop CI; website checks remain separate.

The quick job has a ten-minute timeout and cancels superseded runs. Its real runtime depends on dependency-cache hits; no measured savings claim is made until it has run. macOS and Windows runners are never allocated for an ordinary code push.

## Prepare a release

Update `release.json` on main when a release is intended. That explicit change starts `.github/workflows/desktop.yml`, which automatically builds and publishes a complete private prerelease. Do not change release.json for routine fixes unless a release is wanted.

Alternatively, choose Actions → FarFromDesk desktop release → Run workflow:

- Debugging: select just Linux, Windows, Apple Silicon, or Intel. Leave **publish** unchecked. The default is Linux only.
- Release: select main, target **all**, and check **publish**.

The preflight rejects partial or non-main publication before native runners are allocated. Shared checks must pass before native compilation begins. Version suffixes use the GitHub run ID; build numbers are at least `2000 + run number`.

All four release targets still perform native compilation, portable tests, bundled speech transcription/silence/corruption checks, architecture/archive validation and packaged UI startup. Apple Silicon runs the full backend suite once; shared Flutter analysis and widget tests run once on Ubuntu. A native failure cancels the remaining matrix jobs and prevents publication. Native jobs are capped at 35 minutes each; publication at 15 minutes. These are per-job bounds, not an account-wide spending cap.

## Reuse expensive work

Compiled speech tools retain the pinned cache keyed by runner and speech-recipe/CPU-probe hashes. Application-only changes can reuse that cache; source checksum checks, speech tests and package integrity checks still run. Cache eviction or a recipe change requires compilation again. Node packages and the Flutter SDK use their existing dependency caches.

For a platform-specific failure, use a single-target manual build. For a failed publication job, rerun only failed jobs in the existing run while its artifacts remain available; do not dispatch another four-platform build. Existing artifacts expire after three days. Never combine binaries from different source commits to create a release.

## Publication and downloads

Only the publish job receives `contents: write`. Actions are pinned to commit SHAs. Publication requires all four source-matched manifests, six app archives, six checksums, and two identical version-stamped installers: 18 assets total. It verifies local and remote sizes/digests and repository privacy. Interrupted uploads remain a draft; published releases are immutable.

Mac ZIP and DMG files contain FarFromDesk.app. Windows uses a ZIP, Linux a tar.gz. Private downloads require repository access. GitHub's source archives are not app installers. The README links to `/releases` because prereleases do not resolve through `/releases/latest`.

The older Swift workflow, `.github/workflows/release.yml`, is manual-only and retained for legacy Mac maintenance. It is not the shared desktop release pipeline.

## Billing and distribution limits

GitHub must permit Actions spending. Every allocated job consumes its own runtime, including work performed before cancellation or failure. macOS is substantially more expensive than Linux; parallel workflow elapsed time is not the sum of billed runner usage. Check account usage before requesting repeated native builds. The workflows never raise billing limits or change repository visibility.

No Developer ID/notarization or Windows signing credentials are configured. These remain private previews. Passing isolated native tests does not prove real-phone/provider-account compatibility on every platform. Windows/Linux currently support CLI sessions, not Desktop chat injection.

## Validate pipeline changes locally

Run `actionlint` and `python3 -m unittest discover -s script/tests`. Selection tests cover single-target defaults, full releases, unsupported inputs and rejection of partial/non-main publication. Keep account state, credentials and private recordings out of CI and release assets.

# Automated FarFromDesk releases

## Push to main

`.github/workflows/release.yml` runs after every push to `main`, or from Actions → Mac preview release → Run workflow. Pull requests never publish releases. A newer main push cancels an older unfinished release run.

1. Read `release.json` for the app version.
2. Assign `v<version>-preview.<GitHub run ID>` and an app build number of at least `1000 + run number`.
3. Build independently on `macos-15` (Apple Silicon) and `macos-15-intel` (Intel).
4. Run TypeScript/backend/native tests, then build production app bundles with matching Node and speech runtimes.
5. Validate architectures, signatures, ZIP extraction, bundled voice configuration, synthetic voice/silence/corruption, and DMG integrity.
6. Upload four files per architecture as temporary workflow artifacts.
7. Validate both manifests and all checksums against the triggering commit. Create or resume a private draft prerelease, upload the eight files, verify GitHub's sizes and SHA-256 digests, and publish it.

The publish job alone has `contents: write`; build jobs have read-only access. Actions are pinned to commit SHAs. The publisher refuses public repositories, mismatched commits/builds, incomplete asset sets, symlinks, corrupt files, or misleading signing metadata. A failed architecture prevents publication. Interrupted uploads remain a private draft and can be resumed by rerunning the same workflow. Published releases are immutable; a rerun leaves an already-completed release intact.

## Downloads

Each architecture gets a ZIP and DMG containing `FarFromDesk.app`, a checksum file, and a source/version manifest. GitHub's additional source archives are not app installers. Private downloads require repository access. The README uses `/releases`, because prereleases are not resolved by `/releases/latest`.

Historical `v0.6.2-preview.2` files retain the Sidekick name and bytes. New builds use FarFromDesk and the FFD icon.

## Requirements

GitHub Actions must be enabled and account billing/spending must allow hosted runners. macOS builds consume hosted runner minutes; the workflow does not alter billing settings. No personal access token is needed: publication uses the workflow-scoped GitHub token.

No Apple Developer ID signing identity or notarization credentials are configured. These are explicitly **ad-hoc signed, non-notarized private previews**. Native hardware smoke tests do not establish real-phone/provider compatibility or replace a full UI test. Developer ID signing, hardened-runtime review, notarization and stapling remain necessary for a normal public distribution workflow.

## Local fallback

```sh
npm ci
python3 script/release_macos.py --tag v0.6.2-preview.3 --arch arm64
python3 script/release_macos.py --tag v0.6.2-preview.3 --arch x86_64
```

Use a clean committed checkout and a new preview number. Build outputs stay under ignored `build/releases/<tag>/<arch>/`. The script never restarts the installed app or bridge. Cross-architecture local smoke tests require a compatible execution environment such as Rosetta; report them separately from native hardware tests.

## Maintaining the pipeline

- Update `release.json` for a new app version or local build baseline.
- Keep runtime versions and source checksums pinned in `script/build_speech_runtime.py`.
- Run `actionlint` and `python3 -m unittest discover -s script/tests` for pipeline changes.
- Keep website verification at repository root in `.github/workflows/website.yml`; nested website workflows do not run.
- Windows/Linux are planned and are not advertised as binaries until their build jobs and verification are implemented.
- Repository visibility remains private until the owner explicitly changes it. A public release workflow needs a separate intentional policy update.

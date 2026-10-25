# Building and publishing a Sidekick preview

## Repeatable private release process

Use an Apple Silicon Mac with the prerequisites in [Development](DEVELOPMENT.md). Update the app version/build in `script/package_macos.py` when needed, then commit and push the reviewed source to `main`.

```sh
python3 script/release_macos.py --tag v0.6.2-preview.1
```

Use a new preview number for each release. The script requires a clean working tree, runs TypeScript/backend/native checks, builds the bundled speech runtime, builds Swift in release mode, and installs production-only npm dependencies in a temporary directory. It does not restart the installed app or bridge.

Output goes to `build/releases/<tag>/`:

- `Sidekick-<version>-macOS-arm64.zip` — the actual app download, containing Sidekick.app.
- `SHA256SUMS.txt` — SHA-256 checksums.
- `release-manifest.json` — source commit, version/build, architecture, signing status and archive size/hash.

The recipe verifies bundle signatures before and after ZIP extraction, confirms the app executable is present, and smoke-tests the bundled Node executable. It does not assert notarization or a real-phone test. Existing output is never overwritten.

Check the generated manifest, asset contents, checksums and source commit. Create a tag at that exact commit, push it, and use GitHub's **Releases → Draft a new release** with that tag. Attach the three generated files and user-facing release notes; select **pre-release**. Keep the repository private.

Maintainers can use the GitHub CLI after verifying repository visibility and the reviewed tag:

```sh
gh repo view LazyCodeer/sidekick --json visibility
git tag v0.6.2-preview.1
git push origin v0.6.2-preview.1
gh release create v0.6.2-preview.1 --repo LazyCodeer/sidekick --verify-tag --prerelease \
  --title "Sidekick 0.6.2 — Private preview 1" \
  --notes-file docs/releases/v0.6.2-preview.1.md \
  build/releases/v0.6.2-preview.1/Sidekick-0.6.2-preview.1-macOS-arm64.zip \
  build/releases/v0.6.2-preview.1/SHA256SUMS.txt \
  build/releases/v0.6.2-preview.1/release-manifest.json
```

The GitHub Releases page is the download page; there is no tracked binary folder in the repository. GitHub also adds source archives automatically—those are not the app. Private release assets require repository access. Prereleases do not resolve through GitHub's stable `/releases/latest` shortcut, so the README links to `/releases`.

## Public distribution readiness

Current preview bundles use ad-hoc signatures. No Developer ID signing identity or notarization credential is configured in this workflow. A notarized release pipeline still needs signing, hardened-runtime review, notarization and stapling. Do not describe this preview as ready for frictionless public installation or advise bypassing Gatekeeper.

## Public release checklist

The repository stays private until the owner explicitly changes that decision. Release creation is explicit; ordinary pushes do not publish downloads or change visibility.

- [x] Select MIT for first-party source.
- [ ] Resolve native helper redistribution provenance.
- [ ] Inventory all third-party licenses and source/relink obligations for the exact shipped binaries.
- [ ] Audit staged source, history and generated package for secrets and private data.
- [ ] Verify a clean checkout can build with documented prerequisites.
- [ ] Run fixture suites and opt-in local speech checks.
- [ ] Run real-phone text, voice, attachment, approval and recovery flows for each advertised provider/mode.
- [ ] Publish actual compatibility versions and known limitations.
- [ ] Validate first install, update, pairing retention and uninstall on a separate supported Mac.
- [ ] Measure cold/warm startup, idle memory, catalog discovery and transcription latency.
- [ ] Prepare Developer ID signing, notarization and stapling; do not present ad-hoc signing as public distribution readiness.
- [ ] Check background/login consent and native permission UX.
- [ ] Review dependency inventory, complete Node notices and production packaging size.
- [ ] Configure confidential security reporting and release support policy.
- [ ] Connect only verified website/download links and publish checksums for final assets.
- [ ] Obtain owner's decision to make the repository/release public.

A local build and passing CI are development evidence, not completion of this checklist.

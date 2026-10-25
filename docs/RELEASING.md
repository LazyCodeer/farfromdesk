# Building and publishing Sidekick previews

Use the prerequisites in [Development](DEVELOPMENT.md). Commit reviewed changes before building. Normal pushes do not publish downloads or change repository visibility.

## Build both Mac variants

```sh
python3 script/release_macos.py --tag v0.6.2-preview.2 --arch arm64
python3 script/release_macos.py --tag v0.6.2-preview.2 --arch x86_64
```

Run these sequentially; they share the source compilation and tests. Each architecture has separate Swift, speech, Node, app and archive staging. Node's official target-specific distribution is verified against its versioned SHA-256 checksums. The Intel speech runtime uses CPU inference; the Apple Silicon runtime enables Metal. Do not label an Intel cross-build as Intel hardware tested.

The script requires a clean tree and checks the source commit again before creating artifacts. It runs local checks, builds optimized Swift, installs production-only dependencies in an isolated directory, validates native binary architectures, verifies signatures before and after ZIP extraction, checks bundled speech configuration, and exercises synthetic audio/silence/corruption with the target speech tools. Intel smoke checks on Apple Silicon run through Rosetta and require Rosetta to already be available.

Output in `build/releases/<tag>/<architecture>/`:

- `Sidekick-<version>-macOS-<architecture>.zip` — contains Sidekick.app.
- `Sidekick-<version>-macOS-<architecture>.dmg` — contains the same app and an Applications shortcut.
- `SHA256SUMS-<architecture>.txt` — checksums for the archives and manifest.
- `release-manifest-<architecture>.json` — exact source commit, architecture, version and signing status.

A `.app` is a directory bundle, so it is distributed inside ZIP/DMG rather than uploaded as a single GitHub file. Both formats preserve the same executable app. Existing artifacts are never overwritten; choose a new preview number for subsequent builds. Unpublished earlier candidate builds can remain local and are not automatically uploaded.

## Publish the reviewed assets

Check the manifest, source commit, checksums and repository visibility. Create a tag at that exact commit, push it, then create a private prerelease with all eight files. Do not upload build directories or model caches.

```sh
gh repo view LazyCodeer/sidekick --json visibility
git tag v0.6.2-preview.2
git push origin v0.6.2-preview.2
gh release create v0.6.2-preview.2 --repo LazyCodeer/sidekick --verify-tag --prerelease \
  --title "Sidekick 0.6.2 — Mac preview" \
  --notes-file docs/releases/v0.6.2-preview.2.md \
  build/releases/v0.6.2-preview.2/arm64/* \
  build/releases/v0.6.2-preview.2/x86_64/*
```

The Releases page is the download page. GitHub's automatically added source archives are not app installers. Private assets require repository access. The README links to `/releases`, because prereleases do not use the stable `/releases/latest` shortcut. No tag or release is created by the build script itself.

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

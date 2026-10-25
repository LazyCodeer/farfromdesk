# Public release checklist

The repository stays private until the owner explicitly changes that decision. No automated workflow publishes releases, Pages, packages or artifacts.

- [ ] Select the first-party license and resolve native helper redistribution provenance.
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

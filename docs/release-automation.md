# Automatic app releases

FarFromDesk is a public repository. Standard GitHub-hosted Linux, Windows, Apple Silicon and Intel macOS runners can run public-repository Actions without consuming the private-repository included-minute quota. The verified v0.7.1 release used all four standard hosted targets successfully. Artifact/cache quotas and non-standard paid runner products are separate limits.

SpliceAI uses four self-hosted Linux ARM64 runners on an Azure VM, selected by its `splice` label unless `HOSTED_CI=true`. That machine cannot natively build our Windows, macOS or Linux x64 binaries, and its private-project runner registrations are not shared with this public repository. FarFromDesk keeps standard hosted runners; no extra VM or subscription is required.

## Triggers

- App/build code pushed or merged into `main` runs the release pipeline automatically. No manual edit to `release.json` is needed for an ordinary patch release.
- PRs run quick checks without publication. Website/documentation-only pushes do not rebuild four desktop apps.
- The main pipeline calls quick checks once, avoiding the previous duplicate independent push run.
- A newer main push cancels obsolete in-flight builds. Publication checks that its source commit is still main.
- Manual dispatch can build one selected target without publishing. Publication still requires all four targets and main.

## Version allocation and publication

The planner reads current GitHub release history before allocating native runners. It chooses the next stable patch above all existing stable releases/drafts, respecting a higher explicit `release.json` version as a minimum. A draft for the exact source commit is reused. An already-published exact source commit is skipped to preserve immutable release artifacts.

Quick checks, platform tests, native startup and bundled-speech checks must pass before publication. All four manifests/checksums must agree on version and source commit. Assets are uploaded into a draft, verified remotely, and only then published as the latest stable release. A failed target cannot create a partial public release.

Cache reuse, cancellation and three-day artifact retention remain enabled. This task does not enable a self-hosted runner, change GitHub billing, or deploy the website.

## Native smoke time limits

The native UI smoke has a 90-second startup window, five-second HTTP deadlines, a three-minute overall watchdog and a four-minute workflow step limit. It prints the phase being tested and terminates its disposable GUI process group during cleanup. A stalled native app fails the release gate instead of holding an entire runner until the 35-minute job limit. The regression tests cover stalled HTTP headers/body and a process that ignores SIGTERM; native startup still has to pass on every platform.

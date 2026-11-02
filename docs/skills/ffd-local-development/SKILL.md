---
name: ffd-local-development
description: Continue FarFromDesk Local development, including Social UI, native-session image generation, chat rendering, testing and macOS packaging. Use when another session needs the current source map, design decisions or Local build/install workflow.
---
# FarFromDesk Local development

Start by reading [current-state.md](references/current-state.md). It identifies the actual source snapshot and installed baseline; verify these before editing because they can become stale. Follow the task's current AGENTS.md and RTK instructions.

Then run `scripts/ffd status`. It answers, in one call, what used to take a dozen greps: which version is installed, from which checkout, what is running, whether another session has uncommitted work or a build in flight, and what the next build number is.

Keep the main FarFromDesk app and one testing app named **FarFromDesk Local**. Update Local in place. Preserve production data, the original Codex profile, and other sessions' changes. Check `ffd status` for the source: it is a real shared git checkout now, not the ignored snapshot older notes describe, so a commit there is visible to other sessions and uncommitted work may belong to one. Never reset it or assume its edits are committed.

## Tooling

`scripts/ffd` is the entry point for Local work. See [tooling.md](references/tooling.md)
for the commands and for the traps that cost a session about an hour of avoidable
wall clock on 3 November.

```sh
ffd status                                  # installed version, source, running state, next build
ffd test backend [--baseline]               # npm test, diffed against a stored baseline
ffd test desktop [--all | <test files...>]  # flutter analyze + tests
ffd render <scenario>                       # one Settings screen to a PNG, harness cleaned up
ffd ship [--build N] [--note NAME]          # build, stage, sign, smoke, install, report
ffd rollback [bundle]
```

Do not hand-write a stage or install script; `ffd ship` is the one that carries the
accumulated fixes (SIGKILL escalation for an orphaned backend, the `cp -R -P` copy
that works where `ditto` is denied, a report that always prints).

## Standing defaults for Local work

- **Install into the FarFromDesk Local testing app without asking**, at the next
  build number above the installed bundle. That app exists to be replaced and the
  previous bundle is saved as a rollback first. This remains out of scope:
  production, public releases, credentials and macOS permission grants.
- **Ask the owner, as one question with a recommendation**, for anything they own:
  what to remove from a page, how a new state should look, anything that changes a
  capability rather than its presentation. State the consequence of each option
  honestly, including when a "simplification" removes a real gate.
- **Never run the SDK's `dart format` over existing files**: it rewrites unrelated
  code and the diff has to be reverted by hand.

Choose the relevant reference:
- **Code changes or debugging:** [architecture.md](references/architecture.md).
- **Social UI and image quality:** [design-and-creative.md](references/design-and-creative.md).
- **Build, stage, sign and update Local:** [build-install.md](references/build-install.md).
- **Manual Social sharing and combined-build handoff:** [social-sharing.md](references/social-sharing.md).
- **Verification and owner testing:** [testing.md](references/testing.md).

For generating social artwork rather than developing the app, use the separate `ffd-social-creative` skill. It contains the render engine, art direction and licensed assets. Do not inject this developer handoff into ordinary Social generation sessions.

Use `scripts/inspect_local.py` for read-only build metadata. The packaged smoke helper creates isolated synthetic state; it never reads saved Local/production credentials. Read build-install.md before using it.

This skill carries technical context, not permission to restart, access private state, read saved API keys, publish, send email, release, merge or grant macOS permissions. Use current task authorization. Historical one-off Meta image tests are not reusable permission. If an FFD envelope is present, use that request's current role and exact reply route; never reuse request IDs from old notes.

Report code changed, tests passed, packaged, installed and live verified as distinct states. Update current-state.md and the relevant reference after completing follow-up work, then sync the source copy and any installed copies.

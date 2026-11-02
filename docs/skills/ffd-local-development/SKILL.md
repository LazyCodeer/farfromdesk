---
name: ffd-local-development
description: Continue FarFromDesk Local development, including Social UI, native-session image generation, chat rendering, testing and macOS packaging. Use when another session needs the current source map, design decisions or Local build/install workflow.
---
# FarFromDesk Local development

Start by reading [current-state.md](references/current-state.md). It identifies the actual source snapshot and installed baseline; verify these before editing because they can become stale. Follow the task's current AGENTS.md and RTK instructions.

Keep the main FarFromDesk app and one testing app named **FarFromDesk Local**. Update Local in place. Preserve production data, the original Codex profile, and other sessions' changes. The Local source is an ignored copied snapshot, not an independent Git worktree; a Git command there can report the parent repository. Never reset it or infer that its edits are committed.

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

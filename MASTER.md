# FarFromDesk coordinator prompts

The coordinator ("master") and worker contracts live in code. This file only explains where they come from and how they reach each session.

| Source | Content |
| --- | --- |
| `src/role-instructions.ts` | Shared rules for every session: WhatsApp reply style, progress and final reports, provenance, untrusted data, no replay. Also the MCP server instructions. |
| `src/master-policy.ts` | Coordinator contract (`masterPolicy`) plus `platformCoordinatorPolicy`. `MASTER_POLICY_VERSION` is a display label. |
| `src/worker-policy.ts` | Worker contract. Custom named roles store only their specialty and get the current worker contract appended when read. |
| `src/roles.ts` | `roleConfig` assembles shared rules, the role for this binding's kind, and the style. A role saved for the other kind is ignored. |

## Delivery channels

- Managed CLI sessions: Codex gets the role as `developerInstructions` on `thread/start` and every `thread/resume`; Claude gets it through `--append-system-prompt` (or the SDK preset append). Envelopes then carry only routing metadata.
- Desktop sessions (Claude Desktop, Codex Desktop): the first envelope for each role version carries a one-time role bootstrap. Later envelopes carry the role name, version and private `roleFile`.
- Bridge-created coordinators also get short pointer files (`AGENTS.md`, `CLAUDE.md`, `MASTER.md`, `whatsapp-master` skill) in their support folder. They never copy the role, so they cannot go stale.
- Native catalogs: `farfromdesk-coordinator` and `farfromdesk-worker` are written to `~/.codex/agents` and `~/.claude/agents` on startup. User edited files are never overwritten.

## Refresh

The role version is a hash of the assembled text. Any policy or style change produces a new role document, a new desktop bootstrap and a restart of the managed runtime on its next request. Named agent files are rewritten at startup when their content digest changes and the file was not edited by the owner. The `whatsapp-session` skill is copied only by `install-skills`; rerun it after changing `skills/whatsapp-session/SKILL.md`.

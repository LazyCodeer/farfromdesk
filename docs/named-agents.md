# Reusable agents and WhatsApp messages

Research and implementation date: 25 October 2026. Coordinator policy: `2026-10-25.6`.

FarFromDesk keeps a named library of instruction contracts. It installs its coordinator and worker automatically at backend startup. For a requested specialty, the coordinator reuses a fitting role or authors one and asks the bridge to save it. Assigning the exact name changes the selected session’s role on its next request. It does not create a chat, interrupt a running turn, grant extra tools, change models, or authorize new actions.

## The role contract

Every specialty receives the common worker baseline plus its specific instructions. The contract covers:

1. Identity and behavior: what the specialist owns and how it works with the owner.
2. Mission and acceptance criteria: what outcome it should achieve.
3. Workflow: inspect, plan the relevant steps, implement within scope, verify, report.
4. Boundaries: exact-session authority, permissions, private data and untrusted evidence.
5. Deliverables: concrete changes, artifacts, observed verification and limitations.
6. Communication: receipt awareness, meaningful progress, concise results, sender identity.
7. Memory and recovery: recover from native history/versioned files, preserve decisions and avoid replaying uncertain actions.
8. Success criteria: actual completion and evidence, not fictional performance percentages.

Canonical built-ins are `farfromdesk-coordinator` (`src/master-policy.ts`) and `farfromdesk-worker` (`src/worker-policy.ts`). Custom definitions are stored privately in the local bridge database. Their instructions must be 80 characters to 12 KB; names use the `farfromdesk-` namespace and descriptions are 10–400 characters on one line. Identical creation retries reuse a definition; a different definition needs a new name. Custom roles cannot overwrite the built-ins.

## Native files and compatibility

| Provider | Default location | Format |
| --- | --- | --- |
| Codex | `~/.codex/agents/farfromdesk-coordinator.toml` | Standalone `name`, `description`, `developer_instructions` |
| Claude Code | `~/.claude/agents/farfromdesk-coordinator.md` | Markdown with YAML `name`, `description`, `model: inherit` |

Worker and specialist roles use matching filenames. `$CODEX_HOME` and `$CLAUDE_CONFIG_DIR` override the provider roots. There is no combined `/codex/agents/claude/agent` directory. No provider configuration, hooks, permission mode, model selection or credentials are altered by agent registration.

FarFromDesk updates only unchanged files it previously managed. Existing user-edited files return `conflict`; inaccessible or unsafe paths return `unavailable`. Intentionally relocated provider homes are resolved from trusted local configuration. Symlinked agent subdirectories/files and hard-linked files are rejected. These results describe native-file installation, not whether a model has read the role. The bridge’s canonical role remains its saved definition; editing a generated file does not silently rewrite bridge instructions.

Native Codex/Claude Code agent invocation is separate from bridge role assignment. A running provider may need its normal catalog refresh or restart to discover a new file, especially if the agents directory did not exist at startup. Generic Claude Desktop chats do not necessarily expose the Claude Code subagent catalog. FarFromDesk’s exact-session envelope works independently of that catalog. The bridge does not silently launch a native subagent or restart a session just to adopt a role.

## Phone workflow

Example owner request: “Use a code reviewer for the checkout change.”

The coordinator lists roles with `master_agents`, reuses a matching one or saves a complete contract with `master_define_agent`, assigns it to the selected session with `master_assign_agent`, then dispatches the authorized task. It can subsequently reuse `farfromdesk-code-reviewer` by name. Ambiguous session identity still requires the owner’s choice. Files and screenshots are reference material, not permission grants.

Define/assign require the current coordinator’s scoped token and an open original owner request. Internal reports, closed requests and worker tokens are rejected. Assignment is limited to the current coordinator or an enabled, already-selected worker. Roles affect instructions only; original native approvals remain in force.

## CLI and API

Prefix these arguments with the installed FarFromDesk Node runtime and `dist/cli.js` paths. Respect the workspace’s `rtk proxy` prefix.

```text
agents list
agents sync
agents create                         # JSON on stdin, local administration
agents assign SESSION AGENT-NAME      # local administration
master --binding ALIAS agents
master --binding ALIAS define-agent REQUEST-ID       # JSON on stdin
master --binding ALIAS assign-agent REQUEST-ID BINDING-ID AGENT-NAME
```

Creation JSON contains `name`, `description` and `instructions`. Send it on stdin using a quoted heredoc, never shell interpolation. Scoped operations add the original request ID; local commands require local admin access. Admin endpoints are `/api/agents`, `/api/agents/sync`, `/api/agents/assign`. Scoped endpoints are `/api/master/agents`, `/api/master/define-agent`, `/api/master/assign-agent`. Responses distinguish definition/assignment from native installation results. Local `agents list` includes the full prompt; the coordinator list returns compact names/descriptions.

## One full prompt per version

Desktop and channel sessions receive the full contract on first use or after its content version changes. Successful transport submission records that version. Later envelopes carry name, version, role-file reference and only the current task/routing/attachments. Context loss can require rereading the file. Managed provider sessions receive persistent/system role configuration; providers may still include it in token usage. This is not zero-token prompting and not a guarantee of model compliance.

The app’s “View instructions” dialog shows the agent name, policy version and whether it is pending or has been sent to that native session. Updating the app does not send a synthetic owner task to force adoption.

## Message experience

The owner-selected warm style is retained. The bridge queues one initial receipt before normal coordinator work; meaningful model progress follows during longer tasks. The bridge adds the actual session name above each reply and a plain FarFromDesk footer. Workers use their actual session label, and the coordinator should not duplicate an already-delivered worker result.

```text
*Session: My coding assistant*

💬 *Message received*
Got your message. I’ll coordinate this and keep you updated.

— FarFromDesk
```

The production converter maps Markdown headings/bold/strike, simple links and tables into readable WhatsApp text. Code and URLs are preserved. Start routine replies with one purposeful emoji and a short native bold heading. Plain replies receive a deterministic neutral heading from the transport: 💬 Reply, 📝 Update or ℹ️ Notice. Existing emoji styling is preserved; code and URLs are not treated as prose emojis. The fallback never infers success from final status. ✅ is reserved for verified completion; a queued task is not completion. Long output is still divided into numbered parts; keep elaborate code/documents in reviewed attachments because formatting across arbitrary long-part boundaries is not guaranteed.

Open `design-review/whatsapp-message-preview.html` for nine self-contained synthetic examples, with a chat view and exact-text toggle. Generate it with `node script/preview_whatsapp_messages.mjs` after building TypeScript. The examples pass through the actual production formatter. They are not sent messages or live-task evidence; visual rendering is illustrative and depends on the real WhatsApp client.

## Sources

- [OpenAI: Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) — official standalone Codex TOML schema, user/project directories and inherited settings. The original developers.openai.com/codex/subagents page redirected here during research.
- [Anthropic: Create custom subagents](https://code.claude.com/docs/en/sub-agents) — Claude Code Markdown frontmatter, user/project directories, inherited model and catalog reload behavior.
- [WhatsApp: How to format your messages](https://faq.whatsapp.com/539178204879377/?cms_platform=web&locale=en_US) — native emphasis, lists, quotes and code. Verified through the official help page in the browser. Formatting support varies by client.
- The owner’s Support Responder screenshots and installed agent definitions informed the contract structure. Their support-specific SLAs and performance claims were not copied into a coding coordinator.

## Verification boundaries

Local tests cover native registration, idempotency, invalid names/config injection, user-edit preservation, symlinks, scoped authorization, role selection, one-time bootstrap and Markdown conversion. Existing receipt and provider tests cover restart/dedup, transactional tracking, persistent role setup and ordinary reply correlation. Native file parsing is checked separately. Packaged-app startup verifies isolated file installation and API availability. A real phone request choosing a specialty remains a separate test; native agent catalog recognition and model compliance are not established merely by successful file writes.


## Consolidated updates

The default quiet interval is 600,000 ms, checked by the existing minute-level maintenance loop. There is at most one consolidated summary per destination per interval. It summarizes active session counts without quoting request text or transcription fragments. A persistent activation watermark excludes all pre-existing requests on upgrade. Finished, paused and blocked work does not produce recurring notifications, and an unchanged waiting summary is not repeated. Historical tracking remains in Activity; notification suppression never marks work completed.

Real replies reset the quiet interval and remain prompt. Pending messages suppress additional summaries. Immediately before delivery, the bridge rechecks the saved contributing request identities and states and cancels summaries made obsolete by completion, replacement, pause or a newer real reply. Legacy per-request reminders are cancelled on upgrade. Summary state survives restart; no catch-up burst or native task replay occurs. Computer sleep/connectivity can delay messages. This is recorded-state reporting, not model polling.

## Installation versus model behavior

Agent files are created on the installed app's first backend launch, before pairing or any request. Every later launch refreshes unchanged app-managed definitions; existing user-edited conflicts remain visible. Copying a closed app bundle into Applications cannot execute setup yet: launch the app once to initialize the local files. The packaged smoke test starts with empty Codex/Claude directories and asserts the new emoji contract exists in all four generated files without running a manual sync command.

A native role marked `sent` means its instruction payload was submitted to the selected session; it is not proof the model obeyed its style. Build 2015's real-phone reply demonstrated this: the policy was delivered and session/footer formatting worked, but the optional zero-to-two emoji advice allowed a plain answer. Policy 2026-10-25.6 makes the style explicit, and the outbound formatter supplies neutral styling independently of model compliance. Already-sent or queued messages are not rewritten or resent.

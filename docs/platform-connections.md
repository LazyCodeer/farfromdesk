# Platform and account routing

FarFromDesk supports Codex Desktop, Codex CLI, Claude Desktop Code sessions and Claude Code CLI. Installation, authentication, native-session reachability and successful task execution are separate states. Cursor, Antigravity and other products do not yet have FarFromDesk adapters.

## Choosing a connection

Home → **Coding platforms** has separate Codex and Claude selectors populated from detected Desktop and CLI runtimes. Unavailable or signed-out runtimes remain disabled with a reason. Selecting Desktop or CLI saves immediately through the admin-only `/api/platform-preference` endpoint, without a session picker. Claude Desktop launcher validation happens when creating a session; choosing the runtime does not require a running chat. A previously configured launcher is preserved. The coordinator picker below only changes the master. CLI status is obtained through `codex app-server` (`config/read`, `account/read`) or `claude auth status --json`. Probes do not start model turns, sign in, or read credential files. The app displays masked account information, signed-out status, or an honest unavailable status. Configured API-provider credentials are labelled separately from subscription accounts. Unknown identities cannot start managed CLI work.

Desktop delivery retains the selected native chat and its account. Desktop account identity is not exposed by the current transport, and FarFromDesk does not infer it from CLI authentication. Claude metadata supplies an opaque saved account/organization scope when available; this is provenance, not a verified current login. A live inbox and the exact native ID/project are required. Native login, entitlements and approvals still apply.

For new Claude Desktop chats, choose the launcher session explicitly or use the previously selected launcher. Its native `start_session` creates the child; a receipt and child acknowledgment are required. Codex Desktop creation uses the app-server only to create/name the shared local history record. It does not start a CLI model turn; requests go through the native desktop queue. This is different from managed Codex CLI creation and execution.

## Stored routes

Each binding has a `session-route:<bindingId>` setting containing provider, execution mode, transport (`native-session` or `managed-cli`), profile identifier, optional opaque account fingerprint/scope and a display label. No tokens are stored in this record. The binding remains unique by provider/native session ID: selecting it again cannot create a second competing runtime. Native delivery never switches to managed CLI because of stale managed flags.

Managed CLI account/provider identity is checked before provisioning, recovery and dispatch. A changed account, workspace/provider configuration or profile holds the request; it does not choose another login. Reconnection closes any old managed process so future turns cannot continue in the previous runtime. Account checks have bounded duration, concurrent probes coalesce, and discovery uses a short bounded cache. A failed check is not evidence that Desktop is signed out.

Desktop accounts remain native-app controlled. FarFromDesk cannot independently certify the current login behind a native inbox or detect every account change inside the app. Where metadata exposes a saved account scope, a changed scope is rejected before delivery. No fallback to CLI is permitted.

## Existing connections and recovery

Legacy native connections migrate to an exact native route when next used. A legacy managed CLI binding without a recorded account needs one explicit review through Home → Connected sessions. This establishes the selected current account; it does not claim to recover the account that originally created historical chat data. Queued work may use the reviewed connection, as stated in the confirmation. Existing account changes with unfinished requests require those requests to finish or be closed first. Review does not replay submitted or uncertain messages.

Worker discovery returns `provider:runtime:session-id` targets and displays Desktop/CLI alongside activity. Older provider/session targets remain compatible when they identify the single authoritative catalog entry. Connections accumulate and never disconnect unrelated workers. The picker includes Desktop entries, not just CLI history.

New workers honor `platform-preference:<provider>`, including Codex Desktop and the independently selected Claude Desktop launcher. Changing the coordinator never modifies these preferences. Old coordinator-derived defaults are not migrated because they are not evidence of an independent choice. With no saved preference, creation asks for Desktop or CLI. An explicitly owner-requested runtime can override the preference for that operation. A changed saved CLI account/profile requires review in Coding platforms before new work. Creation IDs freeze the provider, runtime, launcher and task; an uncertain operation cannot be restarted under another account with the same ID.

## Validation

`test/connections.test.ts` covers safe status parsing, probe coalescing, account/workspace changes, stale selector revisions, restart persistence, runtime substitution, native account-scope checks, legacy migration, qualified targets and native versus managed delivery using an isolated fake transport. Master, worker, HTTP and Flutter tests cover defaults, durable retries, scoped authorization, the launcher selector and signed-out creation controls. These are deterministic local checks, not claims that real-phone execution or every provider login was tested.


## Automatic session activation (local lifecycle update)

Historical Claude CLI entries can resume by exact ID through the managed SDK after verified CLI account selection. A live native CLI entry keeps its inbox; a failed live-process scan or conflicting external process prevents duplicate startup. Codex discovery honors its independent default runtime for unbound history. Existing bound routes remain authoritative.

Claude Desktop entries with a saved native identity and account scope can request `claude --desktop --resume <id>` through a terminal, then wait for the same account/project/native ID to have a live inbox before forwarding the task. The open request is durably recorded and coalesced; timeout/restart does not blindly open again. This is an activation attempt, not evidence the app will always start an inbox unattended.

New Claude Desktop sessions can reuse a configured launcher or one of the owner's already-connected Desktop chats. Multiple account scopes require an explicit choice. No unselected chat is chosen. The installed Claude version was checked live: `--desktop` rejects a prompt, `--session-id` and `--name`; it does not provide command-only headless new-chat creation. Native `start_session` plus child acknowledgment remains required, and a missing eligible launcher is reported honestly.

Claude `sessions-index.json` titles enrich only matching existing transcript IDs/projects, improving searches such as a named migration while keeping bounded reads. An index cannot invent sessions. Process busy status and last-activity timestamps do not prove what task is currently running.

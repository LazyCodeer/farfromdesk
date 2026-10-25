# Sidekick technical reference

The native Mac app is in `macos/`. See [Mac app guide](../MAC-APP.md) for building,
installation, supported features and the remaining public-release work.

A personal macOS background application with one dedicated native **WhatsApp master** chat. Scan a QR, enable Claude Code and Codex, then choose sessions by number in WhatsApp. The master coordinates only the chats you select. The original agents retain their own runtime, tools, context and model accounts. No inference proxy or copied conversation history.

## How it works

```text
Your WhatsApp self-chat
        ↕ Baileys linked device
Local durable queue → dedicated native WhatsApp master
        ├─ selected Codex chats via their native queue
        └─ selected Claude chats via their verified live inbox

Numbered selection → exact native UUIDs (handled automatically)

Agent-authored replies / scoped completion hook → durable outbox → WhatsApp
Native PermissionRequest hook → WhatsApp approve/deny → same native request
```

The agent writes every substantive reply. The bridge only adds a session label and splits long text into messages. It never decides whether a task succeeded. A completion hook forwards the native final answer exactly, including any caveats or blockers.

The desktop transport reuses the installed `desktop-session-sync` skill and `~/.local/bin/desktop-sync`. It rechecks Claude's exact session/process/socket on each send and uses `codex queue` for Codex. Its journal is isolated under this application's state directory, separate from other coordination work. No session files are edited.

## Run

Requires macOS, Node 22.13+, the installed desktop-sync helper, and the native apps already signed in. The WhatsApp bridge never reads or copies their model credentials.

```sh
npm ci
npm run build
npm test
npm run bridge -- install-skills
npm run bridge -- install-hooks
npm run bridge -- install
npm run bridge -- open
```

The service uses launchd, starts at login, and restarts after a process crash. Open Session Bridge.app for pairing and settings. Port 47831 now serves only the authenticated local API; the browser dashboard is retired. Only loopback connections are accepted; host, origin, bearer token and per-session credentials are checked. Nothing is exposed publicly.

Scan the QR in Session Bridge.app with WhatsApp → Settings → Linked devices → Link a device. Only owner-originated messages in Message yourself or the selected owner-only group are accepted. Other conversations, incoming strangers and sent-message echoes are ignored. No chat history is imported.

## Register a chat

Normally no manual registration is needed. Send “Show my sessions” or `/sessions` in WhatsApp, then reply “Select 2 and 5” or `2, 5`. Selection automatically binds the exact native IDs from that frozen list. Lists show five sessions per platform ordered by native last activity. Use `/sessions more` (or “check more”) for older results, `/sessions back` for the previous page, and `/sessions NAME` to search the full discovered catalog. Page navigation uses frozen results so new activity cannot renumber a displayed choice. Claude history is discoverable but closed chats are labelled as needing reopening in Claude. Plain messages go to the WhatsApp master; quoting a worker reply addresses that worker directly. Connections are additive and survive restart: choosing another session never disables the earlier workers, including multiple sessions on the same platform. There is no per-platform connection limit. `/pause NAME` remains an explicit way to stop forwarding.

For advanced use, `$whatsapp-session` and the CLI can register an exact session manually.

```sh
npm run bridge -- sessions codex
npm run bridge -- sessions claude
npm run bridge -- register codex project-name EXACT-UUID /absolute/project desktop
```

Claude must be running for discovery and delivery. The Codex desktop queue must support the installed `codex queue` command. Native refusal/held messages remain held; there is no fallback that opens a replacement CLI session.

The optional Claude **channel** mode runs an MCP server inside a chosen Claude session. Generate its configuration with `channel-config NAME`, then relaunch the same session with `claude-channel NAME`. It uses Claude's development-channel flag and depends on account/version support. Desktop mode does not require this flag or a relaunch for inbound delivery.

## Use from WhatsApp

- `/sessions`: discover and list available sessions; add search words to filter.
- `2, 5` or `Select 2 and 5`: select those exact sessions from the last list.
- Plain text: ask the dedicated master to answer or coordinate selected workers.
- `/use project-name`: select the target for plain messages.
- `/to project-name your request`: explicitly address one session.
- Quote an agent's WhatsApp reply to address that exact session, even if another is selected.
- `/status`: inspect submissions, uncertainty and pending requests.
- `/approve CODE` or `/deny CODE`: answer one native permission request once.
- `/answer CODE text`: answer a channel question.
- `/pause NAME` and `/resume NAME`: disable/enable forwarding for that session.
- `/stop NAME`: deny bridge-held permission requests. It does **not** kill or interrupt a native session. Use the native app's stop control to interrupt work.

Claude and Codex keep their normal tools, model choice, instructions, skills, MCP configuration and approval policies. A normal WhatsApp request does not override native permissions.

## Replies and completion

The installed skill teaches the agent to answer an inbound request with its exact request ID:

```sh
node dist/cli.js respond project-name wa:MESSAGE-ID <<'REPLY'
The agent's own final answer goes here.
REPLY
```

Append `progress` for an interim update. For an independent explicit update use `send NAME` with text on stdin.

Stop and PermissionRequest hooks are added to `~/.codex/hooks.json` and `~/.claude/settings.json`, preserving existing hooks and saving backups. **Hooks do nothing for sessions without an explicit registration.** The completion hook consumes `last_assistant_message` from the native event; it does not scrape transcripts. Transcript size/mtime, when needed, is used only to distinguish Claude completion events.

Native apps may require a hook trust/reload step. The installer does not bypass trust controls. Without a loaded completion hook, explicit skill replies still work. Remote approvals require the native PermissionRequest hook to be loaded and trusted. They expire after 15 minutes and never grant blanket/session-wide permissions. Existing native hooks and policy may still block an action.

An explicit final reply suppresses the immediately following Stop notification for two minutes to avoid sending the same result twice. Very closely spaced independent completions within that window may require an explicit `send`.

## Delivery guarantees

SQLite stores inbound IDs, submissions, queued outbound text and stable WhatsApp message IDs before network delivery. Duplicate inbound events do not launch duplicate native submissions. Outbound retry reuses its stored WhatsApp message ID; this is not an exactly-once guarantee from WhatsApp.

- `queued`: waiting locally.
- `dispatched`: native submission in progress.
- `submitted`: native transport accepted it, receipt not yet confirmed by the agent.
- `completed`: the agent explicitly replied to the exact request ID.
- `uncertain`: a crash or error made acceptance ambiguous. Never automatically resubmitted.

Completion-hook output alone does not prove which pending WhatsApp request was handled. The explicit skill response correlates that acknowledgment. `/retry` deliberately refuses ambiguous resubmission; inspect the native chat and journal first.

## Private documents and voice notes

For an owner-authorized document, review its contents and make it self-contained, then prepare the exact file locally:

```sh
node dist/cli.js prepare-file project-name REQUEST-ID /absolute/reviewed-file.html
node dist/cli.js respond-file project-name REQUEST-ID ARTIFACT-ID <<'CAPTION'
Your design review, with all assets included.
CAPTION
node dist/cli.js delivery project-name DELIVERY-ID
```

Preparation requires local admin credentials and reads only the explicitly named canonical regular file. Symlinks/hard links and traversal are rejected. The admin API receives bytes, never a filesystem path or URL. Scoped reply credentials can only send artifacts prepared for that exact binding/request. The original request destination is retained, with owner-only group membership rechecked at delivery. When the owner explicitly requests self-chat for a group-originated request, local preparation may append `--self` to freeze the linked self-chat instead. Scoped document replies cannot change that destination. Filenames, file signatures/UTF-8 and MIME are validated; allowed types are HTML, PDF, PNG, JPEG, TXT, Markdown and CSV, up to 10 MiB. Prepared immutable bytes live in the private SQLite database, with a 100 MiB total cap. File validation is not a content-redaction or malware scanner: the owner/agent must review what they authorize for sharing.

Repeating the same artifact/request/caption returns the same delivery. `queued` includes retry backoff, `sent` means WhatsApp accepted the send call (not read/opened on the phone), and `failed` means a document failed local integrity checks. A document does not mark work complete: follow it with an explicit correlated final `respond` message.

Voice notes use local **FFmpeg + whisper.cpp**, with no external transcription upload. The Mac app from version 0.6.1 bundles both tools and the working multilingual base model and configures them automatically for fresh installations. No speech dependency download happens when a note arrives. For a developer/CLI installation or a custom setup, configure the absolute paths locally:

```sh
node dist/cli.js configure-audio /absolute/ffmpeg /absolute/whisper-cli /absolute/ggml-base.bin
```

Authenticated owner notes (maximum five minutes/10 MiB) are downloaded only from WhatsApp's media endpoint, checked against their plaintext SHA-256, decoded with network protocols disabled, and transcribed with time/size/concurrency limits. A silence check rejects empty recordings before inference. Temporary recordings/transcripts are deleted on completion or cancellation; startup removes scratch recordings left by a crash. The routed transcript becomes normal user input with existing native permissions. Typed permission decisions are required. Quotes address the exact replying session; changes in selection during transcription fail closed. Duplicate events are durably claimed, and interrupted/unsupported/failed notes receive useful feedback rather than disappearing.

Authenticated API paths: admin-only `POST /api/artifacts/prepare` (`bindingId`, `requestId`, `filename`, `base64`, optional `destinationMode` of `request` or `self`) and `POST /api/audio-config` (`ffmpeg`, `whisper`, `model`); scoped `POST /api/session/document` (`requestId`, `artifactId`, `caption`) and `GET /api/session/delivery?id=DELIVERY-ID`. These use the existing loopback, Host/Origin and credential boundary. Worker instructions are in [the WhatsApp session skill](../skills/whatsapp-session/SKILL.md).

Local audio integration test (uses the public JFK sample bundled with whisper.cpp):

```sh
WSB_AUDIO_TEST_MODEL=/absolute/ggml-base.bin \
WSB_AUDIO_TEST_FFMPEG=/absolute/ffmpeg \
WSB_AUDIO_TEST_WHISPER=/absolute/whisper-cli \
WSB_AUDIO_TEST_SAMPLE=/absolute/jfk.wav \
node --import tsx --test test/media-local.test.ts
```

This exercises actual Ogg/Opus decode/transcription, silence/corruption rejection and cleanup. A real WhatsApp phone resend is a separate integration test.

## Local state and operations

Private state: `~/Library/Application Support/WhatsApp Session Bridge/` (owner-only).

- `bridge.sqlite`: registry, message queues and audit events.
- `whatsapp-auth/`: Baileys linked-device credentials, separate from model credentials.
- `bindings/`: per-session scoped credentials.
- `spool/`: durable native completion events awaiting ingestion.
- `native-delivery/`: isolated desktop-sync journals.
- `logs/`: service output; message bodies are not intentionally logged.

```sh
npm run bridge -- status
npm run bridge -- stop-service
```

Stopping the service retains credentials and histories. To uninstall, stop it, remove `~/Library/LaunchAgents/com.sagar.whatsapp-session-bridge.plist`, remove only this bridge's hook entries and skill folders, and unlink its device in WhatsApp. Keep state if you want to resume later.

## Current limits

- Text and locally transcribed voice-note inputs are supported. Incoming images, document uploads and stickers are not forwarded. Outgoing prepared documents are supported as described above.
- Claude Code and Codex are implemented. Cursor and general Claude web/Cowork chats are not implemented.
- The Mac must be awake, logged in and online, and the relevant native session reachable. Closing the lid, sleep, shutdown, revoked WhatsApp pairing, or native app updates can interrupt availability. The application does not change your power settings.
- Claude's inbox frame is version-sensitive, as documented in desktop-session-sync. After incompatible updates, stop and repair the adapter rather than guessing addresses or copying sessions.
- End-to-end delivery and native permission behavior must be verified after WhatsApp pairing and hook trust. Offline tests do not establish that live end-to-end result.

## Validation

`npm test` exercises sender restrictions, exact quoted routing, deduplication, scoped credentials, concurrent sessions, restart recovery, approval isolation, reply ownership and fail-closed retry handling. `npm run build` checks TypeScript. The desktop-sync skill has its own offline transport suite.

## Installed WhatsApp master

The dedicated master is the native chat selected during setup, bound as `whatsapp-master`. Its operating contract is [MASTER.md](../MASTER.md). It stays idle between actual messages; there is no model polling loop. The local watcher refreshes app/session metadata every 30 seconds and on a sessions request. Model usage happens only in the native master or workers when they receive work.

Opening **Session Bridge.app** launches the native Mac UI for pairing, settings, groups and master setup. The CLI open command also opens the native app. Session selection and coordination remain available in WhatsApp.


### Unfinished requests and closing the app

Closing or quitting the Mac UI does not stop the separate background bridge when background access is enabled. Requests saved before dispatch remain in the local database. On a service restart, queued requests resume; deliveries interrupted during submission become **Needs review** and are never automatically resent. Submitted requests remain **Awaiting reply** until their native session records a correlated final reply. This can include an answer that already arrived without a final receipt. Recorded outgoing replies retain their IDs and retry after reconnection.

The app keeps an unfinished count and a link to Activity visible. Activity includes all unfinished requests, even those older than its latest 100 history items, with a short message preview and the exact native session ID. Check that chat for progress and native permission prompts. **Close after review** is available for submitted, uncertain, or failed requests after explicit confirmation; it records `reviewed`, keeps the history, and never claims success, stops native work, or resends a task. Review is blocked during active delivery. A later authentic final reply can still complete the request. Send a new continuation only after checking what already ran.

The local admin-only `POST /api/request-review` accepts `{requestId, expectedStatus, confirmed: true}`. Session-scoped tokens cannot use it, and stale state is rejected. Background pause, Mac sleep, and network/provider outages still prevent progress; opening the UI alone does not bypass them.


### Bulk review and optional automatic cleanup

Activity allows selecting up to 500 eligible requests and closing them together. The admin-only `/api/request-review-bulk` endpoint requires exact request IDs, their expected status and last-update timestamp, plus `confirmed: true`. Validation and writes are atomic: if any request changed, nothing closes. Known active delivery, pending bridge approval/question, and outstanding delegated requests prevent closure.

Settings → Request cleanup is off by default. When enabled, choose 24, 72 or 168 hours without a recorded update. `/api/request-cleanup` persists this choice. A once-per-minute background check marks eligible submitted/uncertain/failed requests `auto_closed`; queued requests are retained, progress resets the inactivity clock, and active delivery/approvals/delegation are protected. Existing old requests are included after enabling. This is tracking cleanup, not proof that the native session stopped: a submitted session can be working without emitting updates. History and late final replies remain available. The Closed tab distinguishes automatic closure from owner review. Auto-closed owner requests cannot authorize new delegation.

Settings → Keep awake while locked uses macOS idle-sleep prevention (`caffeinate -i`) while background access is enabled. It allows screen locking/display sleep without disabling the password. If its assertion process exits, the service retries once per minute while the option remains enabled. It does not override manual sleep, low-battery shutdown or lid-close sleep. Closed-lid operation requires Apple's supported powered external-display setup; no unsupported lid override or system-wide sleep setting is installed.


### Replacing a master with pending work

A replacement can be created while the current master has queued, submitted, active or uncertain requests. The existing master stays active until native setup succeeds. Activation atomically marks its pending requests and related delegated queue `replaced`, disables the old binding and selects the new master. Completed history and unrelated worker requests stay intact. Failed creation leaves the old master and queue unchanged. Already-running work in external native chats may continue; closed requests are not dispatched again, and late callbacks/replies cannot reopen them or route reports into the new master.

Claude's workspace-trust prompt must be accepted by the owner in Claude itself. The app's **Open Claude setup** opens the exact generated master folder in Terminal; approve the folder, exit Claude, then choose **Retry this setup**. The bridge reuses the same pending binding/session identity and first checks whether that session already exists. It does not edit Claude trust settings or auto-approve native prompts. Setup errors shown in the app are concise and do not include raw command arguments or coordinator prompts.


### Account and master overview

The WhatsApp account card shows the normalized phone number, only when a real phone-number JID is available. It never displays a LID as a phone number. **Log out** requires local admin authorization and confirmation, requests unlinking through Baileys, stops the connection, drains pending credential writes and removes the local WhatsApp auth directory. Forwarding and keep-awake are paused. On logout failure, forwarding is still paused and the app directs the owner to reconnect/retry or remove the device in WhatsApp Linked devices. The owner identity, master and request history remain tied to the same account, so a different number cannot receive old work. Logout is not exercised against the owner's live account during automated tests.

An existing master is displayed as **Created**, with its saved name, platform, native-session identifier, availability and selected coding-session names. **Replace master** opens a separate dialog; the setup form only appears on the main page when no master exists. Recovery of a pending setup stays visible alongside the existing master's summary.

### Automatic session connections

The master resolves an owner-named chat through `master_sessions`, then calls `master_connect` with the open owner request and the returned `provider:UUID` target. No separate registration step is required. Ambiguous names produce choices; discovery text and worker reports never grant new authority. The new connection preserves existing bindings, request queues, credentials and native permissions. A paused binding requires the owner to resume it explicitly.

MCP: `master_sessions {search?, page?: 0 | "more" | "back"}`, `master_connect {requestId, targets}`, then `master_dispatch` with returned binding IDs. HTTP equivalents are master-scoped `GET /api/master/sessions?search=NAME&page=more` and `POST /api/master/connect`. CLI: `master --binding ALIAS sessions [search] [--more|--back|--page N]`, `master --binding ALIAS connect REQUEST-ID PROVIDER:UUID[,PROVIDER:UUID]`, then the existing `dispatch` command. Up to 50 connections may be added in one call; this is a request-size limit, not a total session limit.

Claude discovery merges running CLI agents with bounded metadata from saved project session files. It retains names, project paths and activity times, never message bodies. Unknown timestamps are labelled honestly. Closed Claude sessions must be reopened in the native CLI before desktop delivery; discovery does not launch or replace them. Codex lists existing non-archived top-level chats. Other platforms still require their own native transport adapter.

### Phone-controlled native project creation

The master now has `master_create_session` (HTTP `POST /api/master/create-worker`). It takes an open owner request ID, `codex` or `claude`, a project name, task text and a stable event ID. The API returns a durable operation immediately; it does not wait for the phone approval inside an HTTP request.

On first use, the owner receives a typed `/approve CODE` / `/deny CODE` request for `~/Tether Projects`. Approval is stored against the directory's canonical path and filesystem identity. Each new project gets a fresh directory inside that workspace. Names and paths supplied by a model cannot choose another location. Subsequent owner-requested projects reuse the workspace approval. `/workspace` shows it; `/workspace revoke` removes approval, pauses bridge-created workers and closes their managed runtimes while preserving files and history.

Codex workers use the native app-server with `workspace-write` and `on-request` approvals. Claude workers use its documented print/SDK stream with `acceptEdits` and host permission callbacks. The trusted empty workspace is explicitly approved before this headless launch; the bridge never edits the provider's trust database or uses an unrestricted permission mode. Claude's native edit policy is not a separate OS filesystem sandbox. Account and native tool policies still apply. Native approval requests are sent to WhatsApp, and denied/expired/revoked requests fail closed.

New Claude masters also use native headless sessions in their app-created setup directory, with manual tool permissions and scoped coordinator tools. This replaces the background launch path that stopped at folder trust. Existing externally managed Claude sessions keep their native delivery adapter; their permissions are not changed.

Creation states distinguish awaiting approval, creating, ready, denied and uncertain. Ready means native creation succeeded and the task was queued, not completed. A restart never blindly repeats native creation. `master_creation_status` reads the operation; after resolving a blocker, `master_recover_session` resumes its exact saved identity under a new owner request, and never resubmits an existing task. A failed creation with no confirmed native identity remains blocked instead of manufacturing a replacement.

CLI equivalents (use the master alias from the incoming wrapper):
- `master --binding ALIAS create-worker REQUEST-ID PROVIDER NAME EVENT-ID` (task text on stdin)
- `master --binding ALIAS creation-status [OPERATION-ID]`
- `master --binding ALIAS recover-worker REQUEST-ID OPERATION-ID`

Model login is independent of workspace permission. An expired Claude OAuth session must be reauthenticated through Claude's native login before its turns can run. These source changes are not deployed until the bridge is built/reloaded.

### Claude Desktop or CLI

Existing app-owned chats use the `desktop-session-sync` local inbox transport. Its executable only discovers the running sessions; it does not run inference with the standalone CLI account. The bridge now prefers a running Claude Desktop bundled executable, then the configured desktop-sync helper/dynamic desktop launcher. `WSB_CLAUDE_DESKTOP_BIN` can explicitly select that discovery executable. `WSB_CLAUDE_BIN` remains independent and is used for managed CLI session creation.

The bridge checks inbox availability for live discovery and the helper independently rechecks the selected session, process and socket ownership before sending. Missing inboxes are shown as unavailable, not connected merely because a process exists. A successful socket write is submitted, not a completion receipt. Held/refused inbound messages remain held/refused. The setup UI offers Claude Desktop and Claude CLI separately. Desktop uses an explicitly selected app-owned Code session as its launcher, then saves the new desktop master as the launcher for future projects. CLI uses standalone authentication. The selected execution mode is persisted per binding and operation; changing the default does not migrate existing sessions or silently fall back to CLI.

The Claude Desktop creation adapter targets versions exposing `mcp__ccd_session__start_session` with `initiation: "user_asked"`, which starts a requested local session rather than showing the older `spawn_task` suggestion chip. Sidekick sends the request through the selected parent's verified inbox, using a fresh approved project folder and normal native permissions. It does not call private app endpoints or copy credentials. The parent records the exact returned session UUID; the child writes a separate operation-specific startup receipt. Sidekick verifies both receipts, live app ancestry, exact folder and reachable child inbox before activating the binding or queueing the task. Submission alone never marks it ready. Recovery reads the same receipts without resubmitting the creation request.

Master setup: `POST /api/master-create` accepts `provider`, `operationId`, `executionMode` (`desktop` or `cli`), and `desktopParentId` for Desktop. The parent must be an exact app-owned session shown in discovery and selected by the user. Workers inherit the saved choice; `master_create_session` can explicitly specify `executionMode`. CLI equivalent: `master --binding ALIAS create-worker REQUEST-ID claude NAME EVENT-ID desktop` with task text on stdin. No supplied worker path or launcher override is accepted.

**Validation limit:** adapter tests do not establish real-phone launch success for every account and app version. Native folder approval or an unavailable inbox can prevent creation; opening a process or writing to a socket is not evidence that a child started.


### Full Claude Desktop selection

Desktop discovery now reads the app's saved `claude-code-sessions/<account>/<org>/local_*.json` metadata in addition to live processes and CLI history. Only title, project path, native/app IDs, activity time and availability are retained. Archived, inactive and other saved-account records remain visible; their presence does not authorize or establish a connection. The native picker searches names, project paths and IDs, orders by activity and progressively displays the whole catalog.

`POST /api/master-select-desktop` takes an exact `sessionId` and stable `operationId` under local admin authentication. It validates a reachable app-owned session, adopts it as coordinator, and preserves other worker connections. It does not send a message until the owner makes a request. The separate creation action remains optional. The app's `local_...` ID and CLI inbox UUID are mapped explicitly; they are not interchangeable.

Read-only verification found 546 saved Desktop Code records. Live creation and phone round-trip verification remain pending an owner-selected reachable session; no chat is selected automatically from recency or activity.

### Coordinator selection and failed attempts

The Mac setup uses an app dropdown (Claude Desktop, Claude CLI, Codex Desktop, Codex CLI), followed by **Create new session** or **Use existing session**. The bounded, searchable list is shown only when needed. Connectable means a usable transport was found; saved Claude history without a live inbox remains visible with an explanation. Selecting an unavailable row does not start it. Claude Desktop creation requires an explicitly selected reachable launcher. Codex Desktop and CLI share local history and the configured Codex adapter/account: creation uses native `thread/start`, Desktop delivery uses the app queue, and managed CLI delivery uses app-server turns. Neither mode bypasses native permissions. An installed Desktop app and successful creation do not prove that an idle app consumed a queued phone request.

Admin `POST /api/master-select` accepts `provider`, `executionMode`, exact `sessionId`, and stable `operationId`. The old Claude-only `master-select-desktop` endpoint remains compatible. Selection checks the current catalog and project identity before activation. No test message is sent to the selected chat during setup. Codex CLI selection uses the supported native resume path; existing unmanaged Claude CLI sessions retain their live inbox transport.

Failed setups no longer block creation/selection. Starting another operation saves the earlier attempt as `set-aside`, disables its provisional bridge access, and preserves its error and exact identity. `/api/master-recover` and `/api/master-abandon` accept `operationId` to target that attempt. Recovery is explicit and never repeats Desktop creation. Reusing an earlier operation ID returns its stored result instead of creating again. A genuinely in-progress setup remains serialized. Only successful replacement switches the current master and closes its earlier bridge queue. Native histories are retained.

### Session names and compact creation

`POST /api/master-create` additionally accepts optional `name` (trimmed, at most 80 characters, no control characters). Omit it or send an empty name for the automatic `Sidekick · <App> <Mode>` name. A creation ID cannot be reused with a different requested name. Titles are applied to new native Codex, Claude Desktop and Claude CLI sessions and retained during recovery; names do not affect project paths. The Mac form shows the automatic name before creation or lets the user enter a custom one.

The picker distinguishes Codex queue/resume support from Claude live inbox readiness. These indicate transport support, not model quota or successful execution. See [Testing](TESTING.md) for verification boundaries.

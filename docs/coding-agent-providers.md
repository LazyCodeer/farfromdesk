# Coding agents FarFromDesk can drive

Status: research complete 2026-11-03; DeepSeek Harness implemented on `codex/agent-provider-support`.
Evidence appendix: `coding-agent-cli-research-2026-11.md` (one section per tool, source URLs inline).

## Why this exists

FarFromDesk drives a coding agent as a *session*: it starts it, sends it a request, and reads back an
answer. A new provider is only possible when that agent offers all three of:

1. a **non-interactive run** that terminates on its own, so one request is one process;
2. a **machine-readable result** (JSON/NDJSON, or a documented final line) so the bridge reads the
   answer rather than screen-scraping a terminal UI;
3. a **way to continue the same conversation** (a session id, a resume id, or a readable local store).

Plus a fourth that is not about flags: **the vendor permits it**. Antigravity fails that test.

## What FarFromDesk supports

| Provider | Kind | Mode | How a turn runs | Session identity |
| --- | --- | --- | --- | --- |
| `codex` | Codex CLI + Codex Desktop | desktop, cli | app-server JSON-RPC, or the desktop queue | native thread id |
| `claude` | Claude Code CLI + Claude Desktop | desktop, cli | SDK / `--append-system-prompt` runtime, or the desktop chat | native session id |
| `muse` | Muse Code CLI | cli only | one `muse exec --json` per request | session id reported in the JSONL stream |
| `deepseek` | DeepSeek Harness (`dsh`) | cli only | one `dsh --profile headless --json` per request | session id in the opening `session` event, continued with `--session-id` |
| `cursor` | Cursor desktop app | cli only | a `cursor://` deeplink prefills the Composer, then the bridge waits for the chat transcript to record a finished turn | Cursor's chat id, read from the transcript. A picked chat **cannot** be continued |

The bridge treats every provider the same way: a binding records provider + runtime + account scope,
a `SessionRoute` pins the profile, and `Masters.run` hands one request to one provider and waits for a
finished turn. A run that did not finish is reported as a failure; it is never passed off as an answer.

## DeepSeek Harness — verified contract

Verified on this machine against the installed product, not from memory:

| Fact | Evidence |
| --- | --- |
| Launcher `dsh` at `/usr/local/bin/dsh` | `which dsh` |
| `dsh --profile headless "<task>"` answers one task and exits; `-` reads stdin | `dsh --profile headless --help` on the installed build |
| `--json` emits newline-delimited run events instead of the final message | same help output |
| Stream opens with `session`, closes with `final`, carries `status`, `text`, `thinking`, `tool_call`, `tool_result`, `error` | `json-stream.ts` shipped inside the app's `app.asar` |
| Exit 0 = completed, 1 = aborted or errored; a failed turn still emits a `final` event, often empty | `dsh-headless` README shipped in the bundle |
| `--session-id <id>` adopts a persisted session and **refuses** one recorded in another working directory, a subagent or forked session, one with no recorded cwd, or a preset mismatch | same README |
| Sessions are `$DSH_HOME/sessions/--<slugged-cwd>--/<id>/session.vN.jsonl.zstd`, `DSH_HOME` defaults to `~/.dsh` | inspected on disk |
| Other automation profiles exist: `sdk` (JSON-RPC over stdio) and `acp` (Agent Client Protocol) | `dsh --profile sdk --help`, `dsh --profile acp --help` |

Two consequences are baked into the implementation:

- Because adoption is **working-directory scoped**, a coordinator binding's `cwd` must never move, and
  a session discovered under one folder cannot be offered under another.
- Because adoption **refuses subagent and forked sessions**, the catalog skips them rather than
  offering an id the CLI will reject.

### Not yet exercised

No live DeepSeek turn has been run through the bridge. The unit tests use a stub `dsh` that prints
real-shaped NDJSON, which proves the parser and the failure handling but not model access. Also
unknown: how the headless profile behaves when a tool would need approval. The headless profile
exposes no approval or permission flag, and its README does not describe the case, so a run that
blocks on a prompt would sit until the bridge's 20-minute turn timeout. Confirm on a real run before
relying on unattended DeepSeek work.

## Cursor — verified contract

Cursor is a **reader's integration**: the app's own state is readable, but the only way in from
outside is a prompt prefill. Verified on this machine against Cursor 3.27.22:

| Fact | Evidence |
| --- | --- |
| One transcript per chat at `~/.cursor/projects/<project>/agent-transcripts/<chatId>/<chatId>.jsonl`; subagent runs sit in `subagents/` | inspected on disk |
| A transcript is `role`/`message.content` lines of `text` and `tool_use`, and ends with `{"type":"turn_ended","status":"success"}` | a live chat and 30+ older ones, all the same shape |
| Chat titles live in `.../Cursor/User/globalStorage/conversation-search.db`, table `conversations` (`id`, `title`); the transcripts carry no title | `sqlite3 -readonly`, and `node:sqlite` reads it while Cursor is running |
| The project folder is the workspace path with separators turned into `-`, cut short with a `-<hash>` suffix when long, so it is lossy; the bridge resolves it by walking the real filesystem | 41 of 64 folders resolve here, the rest genuinely have no folder (`empty-window`, deleted and temp paths) |
| The only external delivery is `cursor://anysphere.cursor-deeplink/prompt?text=…&workspace=…&mode=…`, whose handler calls `deeplink.prompt.prefill` | `extensions/cursor-deeplink/dist/main.js` shipped in the app |
| That handler **prefills and never submits**, and it does not open a window | same source, and measured below |
| There is no chat API, port, or extension hook to drive the Composer | no listening socket, no third-party `.d.ts`, `state.vscdb` holds only UI state |

Measured delivery behaviour — this is the part that decides how it must be described:

- Four prompts delivered at 18:40:17, 18:45:19, 18:48:19 and 21:03:35 **did** run to completion on
  their own, each in a brand-new chat, with nobody at the keyboard and nothing on our side opening,
  closing or focusing a window. The 21:03 one answered 15–30 s after `open` returned.
- Between 18:49 and 21:03 no delivery was picked up at all: six prompts of 2675, 2023, 1021, 707, 407
  and 123 characters produced no chat, no transcript and no chat-list row, with no error recorded
  anywhere — so it was not a length limit but a transport that had gone quiet.
- The surface then came back on its own at 21:03, with no change on our side.

So Cursor's Composer **does** submit and answer a prefilled prompt on this install, but that cannot be
relied on: the same surface ignored everything for two hours without emitting a single error. Cursor
support is therefore a **hand-off with no delivery guarantee** — the bridge sends the prompt and waits
for a transcript to show a finished turn, and a delivery nobody picks up fails as a timeout instead of
being reported as an answer. `workspace=` is never sent, because routing to a workspace needs an open
project window and is silently ignored without one; that is the likeliest explanation for the quiet
window, since the inert stretch began right after a `workspace=`-routed probe, but it is not proven.

Cursor's CLI (`agent`, installed separately at `~/.local/bin/agent`, `agent -p --output-format
stream-json --resume`) is the autonomous path and needs its own login; it is the next step if Cursor
turns should run without a window.

## Every other agent, and the verdict

Tier 1 means a clean subprocess contract: non-interactive run, machine-readable output, resumable.
Tier 2 means it works with a caveat that changes the design. Tier 3 means it cannot be integrated as
a session at all.

| Agent | Non-interactive | Machine-readable | Resume | Verdict |
| --- | --- | --- | --- | --- |
| **DeepSeek Harness** `dsh` | `--profile headless` | `--json` NDJSON | `--session-id` | **Tier 1, implemented** |
| **Cursor** `agent` | `agent -p` | `--output-format json\|stream-json` | `--resume [chatId]`, `--continue`, `agent create-chat` | **Tier 1 CLI, not yet wired** (needs its own login); the desktop app is wired instead, as a prefill hand-off — see above |
| **Antigravity** `agy` | `agy -p` | `--output-format json\|stream-json`, stdin streaming | `-c`, `--conversation <id>` | **Tier 2, licence blocker — see below** |
| **GitHub Copilot CLI** `copilot` | `copilot -p` | `--output-format=json` | `--resume`, `--continue` | **Tier 1**; needs explicit permission flags or approvals are denied silently |
| **OpenCode** | `opencode run` | `--format json` | `--continue`, `--session <id>` | **Tier 1**; `opencode.db` is a readable local store |
| **Factory Droid** `droid` | `droid exec` | `-o json\|stream-json` | `--resume`, `exec -s <id>` | **Tier 1** |
| **Qwen Code** `qwen` | `qwen -p` | `--output-format json\|stream-json` | `--continue`, `--resume <id>` | **Tier 1** |
| **Kimi Code CLI** `kimi` | `kimi -p` | `--output-format stream-json` | `-c`, `--session <id>` | **Tier 1** |
| **Grok Build** `grok` | `grok -p` | `--output-format json\|streaming-json` | `-r`, `-c` | **Tier 1** |
| **Cline** `cline` | `cline --json` | `--json` NDJSON | `--id <session-id>` | **Tier 1** |
| **OpenHands** | `--headless -t` | `--json` JSONL | `--resume`, `--last` | Tier 1, but the CLI is no longer actively maintained |
| **Gemini CLI** `gemini` | `gemini -p` | `-o json\|stream-json` | `--resume` | Tier 2; consumer access ended 2026-06-18 |
| **Aider** | `--message --yes` | none, text only | `--restore-chat-history` | Tier 2; no machine-readable answer |
| **Amp** | `amp -x` | `--stream-json` | `threads continue` | Tier 2; threads live server-side |
| **Continue** `cn` | `cn -p` | `--format json` | `--resume` | Tier 2; upstream repository archived |
| **Roo Code** `roo` | `roo --print` | `--output-format json` | `--session-id` | Tier 2; extension shut down 2026-05-15 |
| **Devin** `devin` | `devin -p` | none for `-p` | `-c`, `-r` | Tier 2; no JSON on a one-shot run |
| **Antigravity app / IDE** | none | none | GUI picker | **Tier 3** |
| **Windsurf** | none | none | none | **Tier 3** |
| **Zed** | none | none | none | **Tier 3**; Zed is an ACP *client*, it cannot be driven |
| **Replit Agent** | none locally | MCP only | none | **Tier 3**; cloud only |

### The Antigravity blocker

Google's own FAQ says Antigravity CLI headless mode "is intended for direct scripting and CI
workflows. Wrapping `agy` inside third-party coding agents or applications … is not supported under
consumer plans," and that driving it with a third-party app can suspend the account. The supported
route is a Gemini API key (`"modelProvider": "gemini"` + `GEMINI_API_KEY`) or Google Cloud ADC, not
the owner's Antigravity login. That is a product decision for the owner, not an implementation
detail, so Antigravity is **not** wired in this change.

## How to add the next provider

The CLI-only providers share one shape, and Muse Code is the reference implementation:

| Concern | Files |
| --- | --- |
| Where the CLI and its state live | `<provider>-paths.ts`, following `muse-paths.ts` and `dsh-paths.ts`, including the `FFD_ISOLATED_LOCAL` owner-home rule |
| One turn from start to finished answer | `<provider>-session.ts`, following `muse-session.ts` and `dsh-session.ts` |
| Account/profile identity, and the managed-CLI guard | `connections.ts` (`connectionProfile`, `probe*Account`, `prepare`, `assert`) |
| Session discovery for the picker | `native.ts` (`<provider>Catalog`) |
| Platform row, creation and dispatch | `masters.ts` (`masterMode`, `masterName`, discovery, `create`, `provision`, `run`) |
| Labels, icons and enums | `coordinator.ts`, `coordinator-experience.ts`, `companion.ts`, `inbox-view.ts`, `roles.ts`, `server.ts`, `request-events.ts`, `meta-brain-config.ts`, `delivery-choice.ts`, `router.ts`, `ffd.ts`, `owner-commands.ts` |
| Desktop UI | `desktop/lib/connection_status.dart` (label + brand), `screens.dart` (`codingAppProviders`, copy), `app.dart` (brand tile), `memory_panel.dart`, `desktop/assets/logo-<provider>.png` + `pubspec.yaml` |

A provider that is CLI-only, like Muse Code and DeepSeek Harness, has no app session, so it is
registered in `channel` mode, always runs through the managed-CLI transport, and refuses a Desktop
mode request rather than coercing it.

The one structural change worth making before the next two or three providers land is to replace the
per-file `provider === 'x' ? … : …` chains with a single provider table. Roughly twenty files carry
hardcoded provider lists today; every new agent edits all of them, and each edit is a chance to
diverge. That refactor is deliberately **not** part of this change, so the DeepSeek diff stays
reviewable.

## A note on the two protocols worth adopting next

Most of the Tier 1 agents now expose a stdio server instead of, or as well as, a one-shot command:
`dsh --profile acp`, `agent acp`, `copilot --acp --stdio`, `cline --acp`, `opencode acp`,
`openhands acp`, `devin acp`, `grok agent stdio`. DeepSeek and Cursor additionally expose their own
JSON-RPC/SDK modes (`dsh --profile sdk`). One Agent Client Protocol client would replace a bespoke
NDJSON parser per provider and cover several at once. For the two providers that matter most next —
Cursor and Copilot — the one-shot JSON mode is enough to start, and ACP is the upgrade path.
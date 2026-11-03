# AI coding agents: programmatic / CLI automation surfaces on macOS — verified 2026-11-03

**Purpose:** what a macOS bridge app (launch / resume / drive local agent sessions, read machine-readable
output) can actually integrate, per tool. Every fact below was retrieved from the linked page on 2026-11-03.

**Method note.** `web_search` was unavailable in this environment (missing API key), so discovery used
DuckDuckGo Lite via `web_fetch` (`https://lite.duckduckgo.com/lite/?q=…`) plus direct fetches of official docs
domains and raw `github.com` sources. Research was fanned out across 40 + 16 subagents (one researcher + one
adversarial verifier per tool); the verifier re-fetched the cited URLs and its corrections are folded in below.
Load-bearing claims for DeepSeek, Antigravity and Cursor were additionally re-verified by hand.

**Confidence vocabulary.** `high` = exact flag/command/path quoted from first-party docs. `medium` = first-party
docs but a naming/provenance caveat remains. `low` = third-party only, or docs contradict themselves.
Anything not confirmed is written as **unverified** rather than guessed.

**Read this first — three integration blockers that are not about flags:**

1. Google contractually does not support wrapping Antigravity CLI in third-party apps for consumer plans
   ([FAQ](https://antigravity.google/docs/faq)).
2. Windsurf and Zed have **no** agent CLI/headless mode at all (GUI/IDE only).
3. Replit Agent has no local or headless run surface — MCP + an Enterprise Admin API only.

---

## 1. DeepSeek — API plus the official harness (`dsh`)

Vendor: DeepSeek AI. The first-party coding agent is **DeepSeek Harness**, binary `dsh`. It is *not* called
"DeepSeek CLI", and it is not "DeepSeek Coder" (an old model name). Open source, **MIT**, explicitly in
**developer preview** ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES") —
[README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md).
Community projects named `deepseek-cli`, `deepseekcode`, `Reasonix`, `Deep Code` exist but are third-party,
merely curated on [awesome-deepseek-agent](https://github.com/deepseek-ai/awesome-deepseek-agent).

### 1a. API (the stable part)

| Parameter | Value | Source |
|---|---|---|
| OpenAI-compatible base URL | `https://api.deepseek.com` | [First API call](https://api-docs.deepseek.com/) |
| **Anthropic-compatible base URL** | `https://api.deepseek.com/anthropic` | [Anthropic API guide](https://api-docs.deepseek.com/guides/anthropic_api) |
| Anthropic auth | `x-api-key: <key>` **or** `Authorization: Bearer <key>` | same |
| Responses API | Natively supported, "specifically adapted for Codex" | [Changelog 2026-08-13](https://api-docs.deepseek.com/updates) |
| Current models | `deepseek-flash` → DeepSeek-V4.1-Flash-1017; `deepseek-v4-pro` → DeepSeek-V4-Pro-0813 | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| Context / max output | 1M / 384K | same |

- **`deepseek-chat` and `deepseek-reasoner` are withdrawn as of 2026-07-24.** The changelog announced the
  discontinuation on 2026-04-24 ("will be discontinued in three months"), and the current pricing page lists
  only `deepseek-flash` and `deepseek-v4-pro`. No `deepseek-v3.x` alias remains —
  [Change Log](https://api-docs.deepseek.com/updates), [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing).
- Anthropic-format name mapping lets Claude-Code-shaped clients work unchanged: `claude-opus*` →
  `deepseek-v4-pro`; `claude-haiku*`, `claude-sonnet*`, other `claude*` → `deepseek-flash`; unknown names that
  do not start with `claude` return HTTP 400 — [Anthropic API guide](https://api-docs.deepseek.com/guides/anthropic_api).
- Anthropic-endpoint quirks worth knowing: `anthropic-version` is ignored; `top_k`/`container`/`mcp_servers`
  ignored; `tool_choice: "any"` is treated as `auto`; `budget_tokens` ignored; images need
  `anthropic-beta: files-api-2025-04-14` when `source.type` is `file`; `deepseek-v4-pro` replaces images with
  `[Unsupported Image]` — same page.

### 1b. The `dsh` CLI

| Field | Value |
|---|---|
| Install (npm) | `npx @deepseek-ai/dsh web` — [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md) |
| Install (Python SDK) | `pip install deepseek-harness-sdk` (Python 3.10+, macOS 14+ **arm64** listed; ships `dsh` and a native runtime wheel, no system Node needed) — [Python SDK guide](https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk) |
| Non-interactive | `dsh --profile headless "run the tests"` (alias `dsh headless "run the tests"`); `echo "run the tests" \| dsh --profile headless`; task arg `-` reads stdin — [docs/cli-help.md](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cli-help.md) |
| Output contract | final text on **stdout**, reasoning deltas on **stderr**, exit 0 for `completed` else 1 — [apps/cli/reference/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) |
| Structured output | `--json` = "write newline-delimited run events to stdout instead of the final message" — [docs/cli-help.md](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cli-help.md) |
| Other headless flags | `--session-id <id>`, `--permission-mode <preset>`, `--approval-policy ask\|never`, `--add-dir <path>` (repeatable) — same |
| Resume | `dsh --profile headless --session-id session-… "continue"` — the docs' own example comment is "resume an existing Session"; `--session-id` = "adopt the persisted Session with this id; an unknown id is an error" — same. There is **no `--resume` flag** in any shipped profile; `dsh tui --resume <session>` in the help text is only an example of forwarding app-args to a hypothetical `tui` profile. **Do not build on `--resume`.** |
| Embedding servers | `dsh --profile sdk` / `sdk-minimal` = "Serve DeepSeek Harness SDK clients over stdio JSON-RPC"; `dsh --profile acp` = "Serve automation clients over Agent Client Protocol stdio" — same |
| Session storage (macOS) | `<dsh_home>/sessions`, default `~/.dsh/sessions` (`DSH_HOME` overrides). Uncompressed JSONL: `session.jsonl[.zstd]` (v0) / `session.vN.jsonl[.zstd]` (v1+), one directory per session keyed by normalized cwd. Root + JSONL format **verified** ([Python SDK guide](https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk), [architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/)); the exact inner directory encoding (`<root>/--<normalized-cwd>--/<encoded-id>/`) comes from the base bundle patch and is **medium** confidence — [cordis.patch.yml](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/base/cordis.patch.yml) |
| Other paths | profiles `~/.dsh/profiles/<name>`, startup logs `~/.dsh/logs/` |
| Auth | DeepSeek API key: `DEEPSEEK_API_KEY`; resolution order env → `$DSH_HOME/.credentials.yaml` → cwd `.env` → `$DSH_HOME/.env`. No CLI login subcommand documented — [apps/cli/reference/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) |
| Embeddable? | Yes, the best-documented surface in this survey (headless JSON + JSON-RPC + ACP + Python SDK) |
| GUI-only? | No |
| **Confidence** | **high** (developer-preview caveat: expect breaking changes, and session-format migrations are live) |

---

## 2. Google Antigravity

Three separate products: the **Antigravity App** (GUI, macOS 12+ .dmg), the **Antigravity IDE** / IDE extensions,
and the **Antigravity CLI** (`agy`). Closed source; the `google-antigravity` Python SDK is first-party.
The App is GUI-only; the CLI is fully scriptable.

### 2a. Antigravity CLI (`agy`)

| Field | Value |
|---|---|
| Install (macOS) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` → binary `~/.local/bin/agy`; verify `agy --version` — [Get started](https://antigravity.google/docs/getting-started) |
| Non-interactive | `agy -p "In one sentence, what is a git rebase?"` (`-p` / `--print` / `--prompt`) — [Headless mode](https://antigravity.google/docs/cli/headless) |
| Structured output | `--output-format text\|json\|stream-json`; `json` = one envelope with `conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, `usage`; `stream-json` = NDJSON events `init`, `step_update*`, `result` — same |
| Schema output | `--json-schema '<schema\|file\|primitive>'` → parsed object in `structured_output` — same |
| Bidirectional streaming | `--input-format stream-json` = one long-lived process, prompts written as JSON lines to stdin, one `result` event per turn (requires `--output-format stream-json`) — same |
| Other flags | `--model`, `--effort low\|medium\|high`, `--agent`, `--print-timeout` (default `5m`), `--sandbox`, `--dangerously-skip-permissions`, `--disable-slash-commands`, `--mode`, `--add-dir`, `--log-file` — [CLI reference](https://antigravity.google/docs/cli/reference) |
| stdout/stderr split | response on stdout, diagnostics/auth prompts/progress/permission notices on stderr — [Headless mode](https://antigravity.google/docs/cli/headless) |
| Resume | `agy -c` / `agy --continue` (most recent conversation **for the current working directory**), `agy --conversation <conversation-id>` — [Resume command](https://antigravity.google/docs/cli/commands/resume) |
| Session storage (macOS) | Local: `~/.gemini/antigravity-cli/cache/last_conversations.json` (JSON map absolute workspace path → most recent conversation id) and `~/.gemini/antigravity-cli/settings.json` — verified, same page. **Conversation bodies are server-side**: on `--continue` "the CLI queries the backend to verify the conversation still exists". Any local transcript file is **unverified** — do not plan on reading Antigravity history from disk. |
| Auth | (a) Google Account OAuth, tokens in the OS keyring (Apple Keychain), silent when already signed in; (b) `"modelProvider": "gemini"` + `GEMINI_API_KEY` (Google: "suits headless and CI runs"; custom endpoint `GOOGLE_GEMINI_BASE_URL`); (c) Google Cloud ADC via `AGY_ADC_AUTH=true` — [Authenticate](https://antigravity.google/docs/install) |
| Headless permissions | `permissions.allow` rules in settings.json, e.g. `command(git)`, `command(regex:npm run (build\|lint\|test))`, `write_file(src/)`. An un-approvable tool is **soft-denied**: run continues, exits 0, notice on stderr — a silent-failure shape a bridge must detect — [Headless mode](https://antigravity.google/docs/cli/headless) |
| ⚠️ Integration licence | FAQ: "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows. Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans." Also: using third-party software with an Antigravity login violates the ToS and can suspend the account; Google recommends a Gemini Enterprise or AI Studio API key instead — [FAQ](https://antigravity.google/docs/faq) |
| SDK | `pip install google-antigravity`; `LocalAgentConfig`, `Agent`, declarative `allow`/`deny` tool policies — [Get started](https://antigravity.google/docs/getting-started) |
| **Confidence** | **high** (technically); **contractually unsupported for consumer accounts — flag this to the user before integrating** |

### 2b. Antigravity App / IDE

GUI-only. macOS 12+ (Apple Silicon and Intel). Sessions resume via the in-app picker (⌘K); no flags, no
documented programmatic surface. IDE extensions exist for VS Code, Visual Studio, JetBrains, **Zed**, Xcode and
Eclipse, configured with an `auth.type` of `oauth-personal`, `oauth-business`, `gemini-api-key` or
`agent-platform` — [Get started](https://antigravity.google/docs/getting-started), [Authenticate](https://antigravity.google/docs/install).

---

## 3. Cursor

Vendor: Anysphere. Closed source. Installed binary is **`agent`**; `cursor-agent` survives only in legacy and
community sources and is **unverified** against current docs.

| Field | Value |
|---|---|
| Install (macOS) | `curl https://cursor.com/install -fsS \| bash` — [Headless / CI](https://cursor.com/docs/cli/headless) (docs currently show `-fsS`; older posts used `-fsSL`) |
| Non-interactive | `agent -p "find and fix performance issues" --model "gpt-5"`; print mode is also inferred when stdout is not a TTY or stdin is piped. `-p` alone only *proposes* changes — `--force` (alias `--yolo`) is required to apply them — [Overview](https://cursor.com/docs/cli/overview), [Headless / CI](https://cursor.com/docs/cli/headless) |
| Structured output | `--output-format text\|json\|stream-json` (only with `--print` / inferred print). `json` = single terminal object: `{type:"result", subtype:"success", is_error:false, duration_ms, duration_api_ms, result, session_id, request_id?}`. `stream-json` = NDJSON, one line per assistant message, terminal `result`; `--stream-partial-output` adds character-level deltas. **On failure: non-zero exit, error on stderr, no well-formed JSON** — [Output format](https://cursor.com/docs/cli/reference/output-format) |
| Resume | `--resume [chatId]` ("Resume a chat session"); `--continue` (alias for `--resume=-1`); subcommands `agent resume` (latest), `agent ls` (picker), `agent create-chat` (creates an empty chat and **returns its ID** — the clean way to start a drivable session) — [Parameters](https://cursor.com/docs/cli/reference/parameters) |
| Session storage (macOS) | **Partly unverified.** Officially documented: `~/.cursor/cli-config.json` (config, not sessions). A Cursor staff forum post confirms stores under `~/.cursor/chats` and `~/.cursor/acp-sessions/<id>/store.db`. A third-party guide claims `~/.cursor/projects/<project>/agent-transcripts/<session-id>/<session-id>.jsonl`. Neither transcript path was confirmed in official docs — verify on a real install. The reliable contract is `session_id` + `--resume <chatId>`. |
| Auth | `agent login` (browser) **or** `CURSOR_API_KEY` / `--api-key <key>`; `agent status` / `whoami`, `agent logout`. The `json` stream's `init` event reports `apiKeySource: "env"\|"flag"\|"login"` — [Parameters](https://cursor.com/docs/cli/reference/parameters), [Output format](https://cursor.com/docs/cli/reference/output-format) |
| Embedding | `agent acp` = "Start ACP server mode (advanced, hidden command)", documented as "intended for custom ACP clients and advanced integrations" (JSON-RPC over stdio) — [Parameters](https://cursor.com/docs/cli/reference/parameters) |
| Other useful flags | `--trust` (headless only), `--sandbox enabled\|disabled`, `--workspace <path>`, `-w/--worktree [name]` under `~/.cursor/worktrees/<repo>/<name>`, `--plugin-dir`, `--mode plan\|ask`, `--list-models`, `-H/--header` — [Parameters](https://cursor.com/docs/cli/reference/parameters) |
| Config it picks up | `mcp.json` for MCP; `.cursor/rules`, `AGENTS.md`, `CLAUDE.md` for rules — [Using Agent in CLI](https://cursor.com/docs/cli/using) |
| GUI-only? | No. macOS: yes |
| **Confidence** | **high** for install/flags/JSON/auth/ACP; **low** for on-disk transcript paths |

---

## 4. GitHub Copilot CLI

Vendor: GitHub (Microsoft). Repo `github/copilot-cli` is **source-available under a custom licence**
(redistribute unmodified copies as part of a larger app; modification prohibited), not open source.

| Field | Value |
|---|---|
| Install | `npm install -g @github/copilot` · `brew install copilot-cli` (cask) · `curl -fsSL https://gh.io/copilot-install \| bash` · `winget install GitHub.Copilot`. No `gh` extension. macOS explicitly supported — [README](https://github.com/github/copilot-cli) |
| Non-interactive | `copilot -p "Explain this file: ./complex.ts"` — `-p PROMPT` = "Execute a prompt in non-interactive mode. The CLI runs the prompt and exits when done."; piped stdin also works; `-s` = "Suppress stats and decoration, outputting only the agent's response." — [programmatic reference](https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-cli-reference/cli-programmatic-reference.md) (re-verified by hand) |
| Structured output | `--output-format=text\|json`; with `json` "the CLI emits JSONL (one JSON object per line), which is convenient for parsing the agent's output in scripts" — same |
| Permissions in automation | Unanswered approval requests are **denied** without permission flags. Options: `--allow-all-tools`, `--allow-tool='write, shell'` with filters like `shell(git:*)`, `write(.github/copilot-instructions.md)`, `url(https://*.github.com)`, `github(create_issue)`; or `--assisted-approval` (model safety review auto-approves safe requests, denies the rest, "only valid for non-interactive runs"; overrides `--allow-all-tools` when enabled and warns on stderr if enterprise policy blocks it). Env equivalents `COPILOT_ALLOW_ALL=true`, `COPILOT_ASSISTED_APPROVAL=true` — same |
| Resume | `-r, --resume[=VALUE]` (session ID, ID prefix, or session name), `--continue` (most recent in cwd), `-n/--name=NAME` to name a session — [cli-command-reference](https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-cli-reference/cli-command-reference.md) (researcher + verifier, verbatim). ⚠️ `--trust-folder` "Cannot be combined with `--resume`, `--continue`, or `--session-id`" — plan trust and resume as separate invocations |
| Session storage (macOS) | `~/.copilot/session-state/` holds "the complete record of each session", alongside a local SQLite "session store"; settings `~/.copilot/settings.json` (`{"model": …, "effortLevel": …}`); whole tree relocatable via `COPILOT_HOME` (default `~/.copilot`). `--share=PATH` exports the transcript to markdown after a non-interactive run (default `./copilot-session-<ID>.md`) — a ready-made bridge artifact — [session data](https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/security-governance-and-network-settings/session-data.md), [programmatic reference](https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-cli-reference/cli-programmatic-reference.md) |
| Other automation controls | `--model`, `COPILOT_MODEL`, `COPILOT_AUTO_UPDATE=false` (pin the version in CI), `--secret-env-vars=VAR` (redacts values in output; `GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN` redacted by default), `--add-dir`, `--no-ask-user`, `--fleet` (parallel subagents; not supported in ACP server mode), and `copilot workflow run NAME --args @file.json` with its own JSON records and exit codes 0/1/2/130 — same |
| Auth | Copilot subscription via `copilot login`/`/login`, **or** a fine-grained PAT with the **"Copilot Requests"** account permission passed as `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` (classic `ghp_` tokens unsupported); BYOK provider keys allow unauthenticated use but lose GitHub MCP/Code Search — [authenticate](https://raw.githubusercontent.com/github/docs/main/content/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli.md) |
| Embedding | `copilot --acp --stdio` (ACP server, public preview; NDJSON over stdio, or TCP via `--acp --port 3000`) with a TypeScript ACP client example in the docs; plus a headless container image `ghcr.io/github/copilot-cli` published "for Copilot SDK clients" (`COPILOT_CONNECTION_TOKEN` + `COPILOT_GITHUB_TOKEN`) — [README](https://github.com/github/copilot-cli), [ACP server](https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-cli-reference/acp-server.md) |
| GUI-only? | No. End users still need an active Copilot subscription (or BYOK) |
| **Confidence** | **high** (all three load-bearing claims re-verified verbatim by the verifier against official docs) |

---

## 5. Google Gemini CLI — still alive, but consumer service ended

Vendor: Google. Open source, **Apache-2.0** — [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli).

| Field | Value |
|---|---|
| Install | `npm install -g @google/gemini-cli` · `brew install gemini-cli` · `npx @google/gemini-cli` |
| Non-interactive | `gemini -p "Explain the architecture of this codebase"`; `-p/--prompt` "Forces non-interactive mode"; stdin piping works (`cat logs.txt \| gemini`) |
| Structured output | `-o` / `--output-format text\|json\|stream-json`; JSON keys are `response`, `stats`, `error`; documented exit codes `0`/`1`/`42`/`53` — [cli-reference](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/cli-reference.md) |
| Resume | `--resume` / `-r` (bare = latest; index like `gemini --resume 5`), `--list-sessions`, `--delete-session`. Resume by full UUID: **unverified** |
| Session storage (macOS) | `~/.gemini/tmp/<project_hash>/chats/` (verified, [session management](https://geminicli.com/docs/cli/session-management/)). Three other paths reported by the researcher (`shell_history`, `~/.gemini/history/<project_hash>`, `/Library/Application Support/GeminiCli/settings.json`) were **not confirmed and should be treated as unverified** |
| Auth / availability | ⚠️ **Consumer access ended 2026-06-18**: Gemini CLI and the Code Assist IDE extensions stopped serving Google AI Pro/Ultra and free users, who were moved to Antigravity CLI. What remains: Gemini Code Assist Standard/Enterprise, Code Assist for GitHub on Google Cloud, paid Gemini and Gemini Enterprise Agent Platform API keys, `GEMINI_API_KEY`, Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI=true`) — [Google blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) |
| **Confidence** | **high** for flags/JSON/storage/consumer cutoff. README claims about the repo being "maintained for enterprise… / not optimized for Gemini 4+" were **not** independently verified — ignore them |

---

## 6. Aider

Vendor: independent (Aider-AI). Open source, **Apache-2.0** — [Aider-AI/aider](https://github.com/Aider-AI/aider).

| Field | Value |
|---|---|
| Install | `python -m pip install aider-install` then `aider-install`; `curl -LsSf https://aider.chat/install.sh \| sh`; `pipx install aider-chat`. Docs only mention system package managers generically and warn they "often install aider with incorrect dependencies" — **no verified official brew formula** |
| Non-interactive | `aider --message "make a script that prints hello" hello.js` (also `-m`, `--msg`, `--message-file/-f`, `--exit`); `--yes` / `--yes-always` (env `AIDER_YES`, `AIDER_YES_ALWAYS`) "Always say yes to every confirmation" — [scripting](https://aider.chat/docs/scripting.html), [options](https://aider.chat/docs/config/options.html) |
| Structured output | **None.** No `--json` / `--stream-json` / `--output-format` in the options reference; output is colourised terminal text (`--pretty`). A bridge must parse text |
| Resume | `--restore-chat-history` "Restore the previous chat history messages" (default False); chat history file `--chat-history-file` default `.aider.chat.history.md`, input history `.aider.input.history` — [options](https://aider.chat/docs/config/options.html) |
| Storage (macOS) | Project-relative dotfiles (`.aider.chat.history.md`, `.aider.input.history`, `.aider.llm.history`), config `.aider.conf.yml` read from home dir / git root / cwd. No absolute macOS path documented: **unverified** |
| Auth | API keys only (`--api-key deepseek=…`, `--openai-api-key`, `--anthropic-api-key`, or env / `.env`) |
| Embeddable? | Yes as a subprocess, but text-only output, and it expects a git repo |
| **Confidence** | **medium-high** (flags verified; packaging/macOS paths not) |

---

## 7. Amp (Sourcegraph)

Vendor: Sourcegraph / Amp. **Closed source** (`@ampcode/cli` ships prebuilt binaries, licence "SEE LICENSE IN
LICENSE.md"; `github.com/ampcode/amp` 404s).

| Field | Value |
|---|---|
| Install | `curl -fsSL https://ampcode.com/install.sh \| bash`; enterprise alt `npm install -g @ampcode/cli`; macOS app `brew install --cask ampcode/tap/amp@beta` |
| Non-interactive | `amp -x "what files in this folder are markdown files? Print only the filenames."` (`-x`/`--execute`); `echo "…" \| amp -x`; execute mode auto-enables when stdout is redirected — [Execute Mode](https://ampcode.com/docs/cli/execute-mode) |
| Structured output | `--stream-json` (requires `--execute`); plus `--stream-json-input`, `--stream-json-thinking`; NDJSON with `system/init`, `user`, `assistant`, `result` (and `system/subagent_finished`); `--timings` goes to stderr — [Streaming JSON](https://ampcode.com/docs/cli/streaming-json) |
| Resume | `amp threads continue T-…`; CI form `amp threads continue T-… -ox '…'` |
| Storage (macOS) | Settings `~/.config/amp/settings.json` (or `.jsonc`; `--settings-file <path>` override), plugins `~/.config/amp/plugins/`. **Threads are server-side on Sourcegraph infrastructure** — no local thread store documented (**unverified**) |
| Auth | Both: interactive `amp login` (subscription), or headless `AMP_API_KEY` (access token starting `sgamp_`; the CLI rejects the short-lived token from `amp login`) |
| Embedding | Official `@ampcode/sdk` (TypeScript/Python) wrapping the same CLI, or shell out to `amp -x --stream-json`. Requires network to Amp servers; no local-only mode |
| **Confidence** | **high** for flags/paths; **medium** for storage/auth file paths (server-side) |

---

## 8. Cline

Vendor: Cline Bot Inc. Open source, **Apache-2.0** — [cline/cline](https://github.com/cline/cline). It now ships
a genuine CLI plus an embeddable SDK, so it is no longer IDE-only.

| Field | Value |
|---|---|
| Install | CLI `npm install -g cline` (Node 20+, 22 recommended); VS Code extension from the marketplace — [CLI overview](https://docs.cline.bot/usage/cli-overview) |
| Non-interactive | `cline --json "list TODO comments"`; `cline --auto-approve true "run tests and fix failures"`; `cat file \| cline "task"`; `cline --timeout 600 "run full test suite"`. "Headless is triggered when using flags like `--json`, when stdin is piped, or when output is redirected" — [CLI reference](https://docs.cline.bot/cli/cli-reference) |
| Structured output | `--json` = NDJSON objects with `type`/`ts`: `agent_event`, `hook_event`, `team_event`, `run_result`, `run_aborted`. Documented jq idiom: `cline --json "summarize this changelog" \| jq -r 'select(.type == "run_result") \| .text'` — same |
| Resume | `--id <session-id>` "Resume an existing session by ID"; `cline history export <session-id>`, `cline history delete --session-id <id>`. **Correction from verification: `cline history --session-id <id>` does not exist** — the flag applies only to `delete`/`update` |
| Storage (macOS) | CLI `--config` default `~/.cline`, `--data-dir` default `~/.cline/data`, sessions `~/.cline/data/sessions/`, SQLite `~/.cline/data/db/sessions.db`, logs `~/.cline/data/logs/cline.log`; provider settings live at `~/.cline/data/settings/providers.json` (**corrected path** — not directly under `data/`). VS Code extension tasks are **not** shared with `~/.cline/data` (separate globalStorage) |
| Auth | `cline auth` (Cline provider pay-as-you-go / ClinePass / own key); `-k/--key <api-key>`; `CLINE_API_KEY` |
| Embedding | `npm install @cline/sdk` "for embedding Cline's agent runtime in your own applications", or spawn `cline --acp` (ACP over stdio) — [SDK overview](https://docs.cline.bot/sdk/overview) |
| **Confidence** | **high** (verifier confirmed non-interactive/JSON/storage verbatim and caught two errors, both corrected above) |

---

## 9. Roo Code — ⚠️ extension shut down, CLI still published

Vendor: Roo Code, Inc. Apache-2.0 — [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code).
**The repo README states "The Roo Code Extension was shut down on May 15th"** (docs footer last updated
2026-05-15). The `main` source and the CLI installer remain live, but this is a project in wind-down.

| Field | Value |
|---|---|
| Install | CLI (documented in-repo, not on the docs site): `curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh \| sh` → installs to `~/.roo/cli`, symlinks `~/.local/bin/roo`, requires Node 20+. Supported: "macOS Apple Silicon (M1/M2/M3/M4) or Linux x64" — **macOS Apple Silicon only**; Intel macOS unverified — [install.sh](https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh) |
| Non-interactive | `roo --print "Summarize this repository"`; streaming form `printf '{"command":"start","requestId":"1","prompt":"1+1=?"}\n' \| roo --print --stdin-prompt-stream --output-format stream-json` |
| Structured output | `--output-format text\|json\|stream-json` (only with `--print`); `roo list sessions --format json` |
| Resume | `--session-id <id>` ("Resume a specific task by session ID"), `-c/--continue` ("Resume the most recent task in the current workspace"), `--create-with-session-id <uuid>` |
| Storage (macOS) | CLI config `~/.roo` with `cli-history.json`; task state under `~/.vscode-mock/global-storage/tasks/<taskId>/history_item.json` + `tasks/_index.json`; `--ephemeral` uses `os.tmpdir()`. Real VS Code globalStorage path: **unverified** |
| Auth | API keys only (`-k/--api-key`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`) |
| Embedding | Partial: scriptable CLI (stdin NDJSON → JSON stdout) but **no task-level programmatic SDK**; `lib/sdk/client.ts` is only a Roo Cloud tRPC auth client |
| **Confidence** | **high** for flags/paths (read from source); **medium** on whether the CLI will keep being shipped |

---

## 10. OpenCode

Vendor: Anomaly (formerly `sst/opencode`; the old repo redirects). Open source, **MIT** —
[anomalyco/opencode](https://github.com/anomalyco/opencode). One of the strongest integration targets.

| Field | Value |
|---|---|
| Install | `curl -fsSL https://opencode.ai/install \| bash`; `npm install -g opencode-ai`; `brew install anomalyco/tap/opencode` (docs warn plain `brew install opencode` "currently installs V2" while the tap is V1, and V1/V2 cannot coexist) — [CLI docs](https://opencode.ai/docs/cli/) |
| Non-interactive | `opencode run "Explain how closures work in JavaScript"`; `opencode run --attach http://localhost:4096 "…"` |
| Structured output | `--format default\|json` ("raw JSON events"); `opencode session list --format json`; `opencode export [sessionID]` |
| Resume | `--continue`/`-c` ("Continue the last session"), `--session`/`-s <id>` ("Session ID to continue"), `--fork` ("Fork the session when continuing") |
| Storage (macOS) | `~/.local/share/opencode/` — `auth.json`, `log/`, `opencode.db` ("SQLite database containing projects, sessions, and messages"), `snapshot/`; `opencode db path` prints the active DB. Config `~/.config/opencode/opencode.jsonc`. Desktop app data `~/Library/Application Support/ai.opencode.desktop/`, cache `~/.cache/opencode` — [troubleshooting](https://opencode.ai/docs/troubleshooting/) |
| Auth | Both: `/connect` subscription login, or provider API keys via `opencode auth login` (stored in `~/.local/share/opencode/auth.json`) |
| Embedding | `opencode serve` = headless HTTP server with OpenAPI 3.1 (`/doc`, default `127.0.0.1:4096`, optional `OPENCODE_SERVER_PASSWORD`); typed SDK `npm install @opencode-ai/sdk` (`createOpencode()` / `createOpencodeClient()`); `opencode acp` — [server](https://opencode.ai/docs/server/), [sdk](https://opencode.ai/docs/sdk/) |
| **Confidence** | **high** for CLI/server/SDK/storage (docs last updated 2026-11-02); **medium** on V1-vs-V2 packaging overlap |

---

## 11. OpenHands

Vendor: All Hands AI. Open source, **MIT** — [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands),
CLI at [OpenHands/OpenHands-CLI](https://github.com/OpenHands/OpenHands-CLI). ⚠️ Docs state "The OpenHands CLI is
no longer actively maintained"; the maintained path is Agent Canvas (GUI-first, with `--backend-only`).

| Field | Value |
|---|---|
| Install | `uv tool install openhands --python 3.12` (needs uv ≥0.11.6) or `curl -fsSL https://install.openhands.dev/install.sh \| sh`. macOS documented, including Gatekeeper "Allow Anyway" steps for the binary — [installation](https://docs.openhands.dev/openhands/usage/cli/installation) |
| Non-interactive | `openhands --headless -t "Your task here"` or `--headless -f task.txt`; headless **always** runs `always-approve` (`--llm-approve` unavailable there) — [headless](https://docs.openhands.dev/openhands/usage/cli/headless) |
| Structured output | `--json` = JSONL, requires `--headless` — [command reference](https://docs.openhands.dev/openhands/usage/cli/command-reference) |
| Resume | `--resume [ID]` (no ID lists recent), `--resume --last`, `openhands acp --resume <id>`. `--headless` + `--resume` together: **unverified** |
| Storage (macOS) | `~/.openhands/conversations` (docs). The deeper `conversations/<id>/conversation.json` filename came from the researcher and was **not** confirmed by the verifier — treat as **unverified**. Settings `~/.openhands/agent_settings.json`, `~/.openhands/cli_config.json`, `~/.openhands/mcp.json` |
| Auth | `openhands login` (cloud account) or BYO LLM key in `agent_settings.json` / `LLM_API_KEY`+`LLM_MODEL` with `--override-with-envs` |
| Embedding | Yes: MIT Python + REST Software Agent SDK, REST agent server, `openhands acp`, OpenAI-compatible endpoint |
| **Confidence** | **high** for flags and the conversations root; **medium** for macOS runtime behaviour (not executed) |

---

## 12. Continue — ⚠️ repo read-only, but `cn` + HTTP server exist

Vendor: Continue Dev, Inc. Apache-2.0 —
[continuedev/continue](https://github.com/continuedev/continue). **README: "The `continuedev/continue`
repository is no longer actively maintained and is read-only for all users."** Final release **2.0.0**.

| Field | Value |
|---|---|
| Install | `curl -fsSL https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/scripts/install.sh \| bash`, or `npm i -g @continuedev/cli` (Node 20+). macOS is the first-listed platform |
| Non-interactive | `cn -p "your prompt"`; piping documented: `git diff --staged \| cn -p "Write a commit message for this diff"`; also `cn -p --resume` — [headless mode](https://docs.continue.dev/cli/headless-mode) |
| Structured output | `--format json` (headless/scripts) and `--silent` (strips thinking tags); `cn ls --json` |
| Resume | `cn --resume` (most recent); TUI `/resume`; `cn --fork <sessionId>` |
| Storage (macOS) | `~/.continue/sessions/<uuid>.json` (`getSessionDir()` → `<continueHome>/sessions`, `CONTINUE_GLOBAL_DIR` override); config `~/.continue/config.yaml`, permissions `~/.continue/permissions.yaml` — [session.ts](https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/src/session.ts) |
| Auth | ⚠️ Docs still advertise `cn login` / `CONTINUE_API_KEY`, but the source says "Hub/WorkOS authentication has been removed… no-op stubs" and `apiClient.ts` errors "Not authenticated. Hub integration has been removed." The 2.0.0 notes confirm auth was pulled. Current path: configure a model/API key in `config.yaml`. Exact env var: **unverified** |
| Embedding | `cn serve` (hidden) starts an HTTP server: `GET /state`, `POST /message`, `POST /permission`, `POST /pause`, `GET /diff`, `POST /exit`; `--port` (default 8000), `--timeout` (default 300) — [serve.ts](https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/src/commands/serve.ts) |
| **Confidence** | **high** for CLI/flags/paths/serve; **medium** for auth (docs contradict source); longevity doubtful |

---

## 13. Windsurf (formerly Codeium) — ⚠️ no agent CLI; fold into Devin

| Field | Value |
|---|---|
| Status | Cognition acquired Windsurf; `docs.windsurf.com` now **302-redirects to `docs.devin.ai`**. The legacy `surf` binary became `devin-desktop` (2026-06-02), and Cascade is documented as **legacy** — new conversations no longer open in it. JetBrains Cascade plugin is in maintenance mode — [Cascade (legacy)](https://docs.devin.ai/desktop/cascade.md), [Devin Desktop FAQ](https://docs.devin.ai/desktop/devin-desktop-faq.md) |
| Non-interactive / JSON / resume | **None** (unverified for any Windsurf CLI). The IDE's binaries only open files |
| Storage (macOS) | `~/Library/Application Support/Devin/` (IDE data), `~/.codeium/` (settings, MCP, skills, workflows). Cascade conversation DB path: **unverified** |
| Auth | Subscription / IDE login only. **No API-key mode** |
| Embeddable? | **No** — no headless entrypoint. Notably it *hosts* ACP agents rather than being one — [ACP](https://docs.devin.ai/desktop/acp.md) |
| GUI/IDE-only? | **Yes** |
| **Confidence** | **high** |

---

## 14. Devin (Cognition)

Vendor: Cognition. CLI closed source. **`devin` is a real local CLI**, and it also offers a cloud mode.

| Field | Value |
|---|---|
| Install | `curl -fsSL https://cli.devin.ai/install.sh \| bash` (→ `~/.local/bin/devin`); `brew install --cask devin-cli`; Windows `irm https://static.devin.ai/cli/setup.ps1 \| iex` — [CLI quickstart](https://docs.devin.ai/cli) |
| Non-interactive | `devin -p "prompt"` (`--print` "Print response and exit (non-interactive mode)"); cloud `devin --cloud -p "prompt"`. **In non-interactive mode there is no workspace-trust prompt, so `-p` fails in an untrusted directory unless you pass `--respect-workspace-trust false`** — [commands & flags](https://docs.devin.ai/cli/reference/commands.md) |
| Structured output | **No JSON for `-p`** (unverified). JSON only for metadata commands: `devin list --format json\|csv`, `devin models list --format json`, `devin doctor --json`. `--export [PATH]` writes an ATIF conversation file |
| Resume | `-c/--continue` ("Resume the most recent session in the current directory"), `-r/--resume <SESSION_ID>`; with `--cloud`, accepts a cloud session ID or URL |
| Storage (macOS) | Only the logs path `~/.local/share/devin/cli/logs/` is documented. `~/.local/share/devin/credentials.toml`, `~/.config/devin/config.json` and `~/Library/Application Support/devin/cli/sessions.db` were **not** confirmed in official docs — **unverified** |
| Auth | `devin auth login` (browser/PKCE; `--force-manual-token-flow`); ACP reads `WINDSURF_API_KEY`; the v3 cloud API uses a `cog_` service-user key/PAT. No documented `DEVIN_API_KEY` env for the CLI |
| Embedding | Yes — `devin -p` plus `devin acp` (JSON-RPC over stdio; documented for Xcode) |
| **Confidence** | **medium-high** for flags/JSON/resume; **low** for storage paths |

---

## 15. Factory Droid (Factory AI)

Vendor: Factory AI. CLI closed source; the TypeScript SDK is Apache-2.0 —
[droid-sdk-typescript](https://github.com/Factory-AI/droid-sdk-typescript).

| Field | Value |
|---|---|
| Install | `curl -fsSL https://app.factory.ai/cli \| sh`; `brew install --cask droid`; `npm install -g droid` — [CLI reference](https://docs.factory.com/droid-cli/cli-reference) |
| Non-interactive | `droid exec "query"`, e.g. `droid exec --auto medium "install deps, run tests, and fix failing checks"`. Docs frame it as two modes: interactive `droid` and "Non-interactive (`droid exec`) – Single-shot execution for automation and scripting" — [Droid Exec](https://docs.factory.com/droid-exec/overview) |
| Structured output | `-o/--output-format text\|json\|stream-json\|stream-jsonrpc\|acp` (the CLI reference omits `acp`; the exec page adds it); `--input-format stream-jsonrpc` for multi-turn |
| Resume | `droid --resume [sessionId]` (alias `-r`), `droid exec -s <session-id> "continue"`, `--fork <id>` |
| Storage (macOS) | `~/.factory/settings.json` verified; the sessions directory `~/.factory/sessions` was **not** in official docs — **unverified** |
| Auth | Browser OAuth for interactive; headless needs `export FACTORY_API_KEY=fk-...`; BYOK custom models supported |
| Embedding | `@factory/droid-sdk` (npm) spawns the CLI or connects to a running `droid daemon`; also a public REST API |
| **Confidence** | **high** for flags; **low** for the sessions directory |

---

## 16. Qwen Code (Alibaba)

Vendor: Alibaba Qwen team. Open source, **Apache-2.0** — [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code).

| Field | Value |
|---|---|
| Install | `curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh \| bash` (listed "Linux / macOS"); `npm install -g @qwen-code/qwen-code@latest` (Node 22+); `brew install qwen-code` — [README](https://github.com/QwenLM/qwen-code) |
| Non-interactive | `qwen -p "query" --output-format json`; `--yolo` / `--approval-mode yolo` for unattended runs — [headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/) |
| Structured output | `--output-format json` (buffered array) or `stream-json` (JSONL); `--include-partial-messages` adds deltas; `--input-format text\|stream-json` (stream-json marked "under construction"). **Correction from verification: the schema-constraint flag is `--json-schema`** (headless-only, `@file` or inline), separate from `--output-format` — [structured output](https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/structured-output.md) |
| Resume | `qwen --continue -p "…"` (most recent, project-scoped); `qwen --resume <sessionId> -p "…"` |
| Storage (macOS) | `~/.qwen/projects/<sanitized-cwd>/chats` (project-scoped JSONL); settings `~/.qwen/settings.json`, `.qwen/.env` |
| Auth | Keys/subscriptions only: QwenCloud Token Plan (`QWENCLOUD_TOKEN_PLAN_API_KEY`, `sk-sp-`), Standard API keys, Alibaba ModelStudio Coding Plan (`BAILIAN_CODING_PLAN_API_KEY`), third-party providers. **Qwen OAuth free tier ended 2026-04-15** and `qwen auth` was removed — env vars / `settings.json` only — [auth docs](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) |
| Embedding | Headless CLI + JSON/stream-json, TS/Python/Java SDKs, and an experimental `qwen serve` HTTP+SSE daemon (default `127.0.0.1:4170`, optional `QWEN_SERVER_TOKEN` / `--require-auth`) |
| **Confidence** | **high** |

---

## 17. Kimi CLI (Moonshot AI) — the tool renamed itself

⚠️ **`kimi-cli` is archived.** The current first-party tool is **Kimi Code CLI**, binary `kimi`, repo
[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), **MIT**, closed-source vendor distribution.

| Field | Value |
|---|---|
| Install | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash`; `npm install -g @moonshot-ai/kimi-code` (Node ≥22.19); brew `kimi-code` per the legacy README |
| Non-interactive | `kimi -p "Summarize the current repository status"` — `--prompt <prompt> \| -p`: "Run a single prompt non-interactively and stream the Assistant output to stdout" — [kimi command](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html) |
| Structured output | `--output-format text\|stream-json` (JSONL, one object per line; **only usable with `--prompt`**) — same |
| Resume | `-c`/`--continue`, `-S`/`--session [id]`; `-r`/`--resume` is a **hidden alias** for `--session` — same |
| Storage (macOS) | `~/.kimi-code/` (override `KIMI_CODE_HOME`); sessions nested at `~/.kimi-code/sessions/<workspaceId>/<sessionId>/`; credentials `~/.kimi-code/credentials/` — [data locations](https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html) |
| Auth | `kimi login` (OAuth device-code) or a Moonshot / `platform.kimi.com` API key; TUI `/login` |
| Embedding | Yes — CLI/ACP subprocess with exit codes 0/1/75, plus `kimi web` REST/WS |
| Legacy | archived `kimi-cli` (Apache-2.0, Python) used `--print` + `--output-format=stream-json` and stored data in `~/.kimi/` |
| **Confidence** | **high** |

---

## 18. Grok CLI (xAI) — an official CLI does exist

There are two different tools; a bridge must not confuse them.

### 18a. Grok Build (official xAI)

| Field | Value |
|---|---|
| Install | `curl -fsSL https://x.ai/cli/install.sh \| bash` or `npm i -g @xai-official/grok` (Apache-2.0 licence field; no public source repo stated); macOS arm64/x86_64 listed |
| Non-interactive | `grok -p "Your prompt here"` — flag table: `-p, --single <PROMPT>` "Send one prompt" — [headless scripting](https://docs.x.ai/build/cli/headless-scripting.md) |
| Structured output | `--output-format plain\|json\|streaming-json` (`json` = one JSON object at the end) |
| Resume | `-r/--resume <ID>`, `-c/--continue`, `--fork-session`; `grok sessions list`. ⚠️ `-s/--session-id` names a **new** session and does **not** resume |
| Storage (macOS) | `~/.grok/sessions/` (keyed by working directory); config `~/.grok/config.toml` — [sessions](https://docs.x.ai/build/features/sessions.md) |
| Auth | `grok login` (browser) or `XAI_API_KEY` for headless/CI |
| Embedding | Headless JSON, or ACP via `grok agent stdio` (JSON-RPC over stdin/stdout) |
| **Confidence** | **high** |

### 18b. `grok-cli` (community, superagent-ai)

MIT, [superagent-ai/grok-cli](https://github.com/superagent-ai/grok-cli), explicitly "not affiliated with xAI".
`grok --prompt "…"` (`-p`), `--format json` (NDJSON), `-s <session-id>` / `--session latest`,
`~/.grok/user-settings.json`, API key only (`GROK_API_KEY`, `grok -k <key>`). **Binary name `grok` collides
with the official CLI** — a real hazard for a launcher. Confidence: **medium**.

---

## 19. Zed editor — GUI only for automation, but it speaks ACP

Vendor: Zed Industries. Open source, **GPL-3.0** (`LICENSE-GPL`) —
[zed-industries/zed](https://github.com/zed-industries/zed).

| Field | Value |
|---|---|
| Install | macOS: run `cli: install cli binary` from the command palette → installs `/usr/local/bin/zed` — [CLI reference](https://zed.dev/docs/reference/cli) |
| Non-interactive | **None.** `zed [OPTIONS] [PATHS]...` only opens the editor: `--wait`, `-n`, `--diff`, `--foreground`, `--completions`, `--version`, `--uninstall`. No flag runs an agent or accepts a prompt — verified against both the docs and `crates/cli/src/main.rs` |
| Structured output | **None.** The researcher's claimed hidden `zed --printenv` **does not exist** (zero matches in the CLI source) — removed as an invention |
| Resume | **None.** Threads restore only in the GUI (Thread History) |
| Storage (macOS) | Official docs give only the default dir `~/Library/Application Support/Zed`. `threads/threads.db` (SQLite) and `db/0-<channel>/db.sqlite` come from a third-party reverse-engineering write-up — **unverified** |
| Auth | GUI sign-in (Zed Pro/Business) or your own LLM provider key; external ACP agents carry their own auth |
| Embeddable? | **No** as a component (GPUI desktop app, no library/IPC automation surface). But ACP means Zed drives external agents — a bridge could implement an **ACP agent** that Zed talks to — [External Agents](https://zed.dev/docs/ai/external-agents), [ACP spec](https://github.com/agentclientprotocol/agent-client-protocol) |
| GUI/IDE-only? | **Yes** (for automation) |
| **Confidence** | **high** |

---

## 20. Replit Agent — cloud/browser only, no local surface

Vendor: Replit Inc. Closed source.

| Field | Value |
|---|---|
| Local CLI for Agent runs | **None exists.** No CLI verb, no local session files, no headless run mode |
| Only programmatic path | The **Replit MCP server**: `claude mcp add replit https://mcp.replit.com/server/mcp --transport http`. Tools include `create_app_from_prompt(appDescription, app_stack)`, `update_app_using_prompt(replId, changeDescription)`, plus `ask_question`, `publish_app`, `get_publish_status`, `list_apps` (the researcher's claim that create/update were the *sole* path was corrected by the verifier) — [MCP server](https://docs.replit.com/platforms/mcp-server) |
| Structured output | MCP tool JSON objects only; no CLI JSON flag |
| Resume | **None** (unverified / not applicable) |
| Storage (macOS) | **None** — browser/cloud only |
| Auth | MCP = OAuth protected-resource discovery at `https://mcp.replit.com/server/mcp`. Admin API = Enterprise subscription with an `rpl_` Bearer key — [Admin API](https://docs.replit.com/teams/admin-api) |
| Embeddable? | Only as an MCP Streamable-HTTP/OAuth client. A public "agent invoke" REST API is a forum feature request, never shipped |
| GUI/IDE-only? | Agent runs are cloud/browser-triggered; the MCP server itself is non-GUI |
| **Confidence** | **high** for MCP/Admin API; **medium** for the absence of any Agent REST API |

---

## Summary table

Legend: **NI** = non-interactive invocation exists · **JSON** = machine-readable output · **Resume** = session
resume · **Store** = local session store on macOS a bridge can read · **OS** = open source · **Emb** = embedding
surface beyond spawning the binary.

| # | Tool | Binary / cmd | NI | JSON | Resume | Local session store (macOS) | Auth | OS | Emb | Verdict for the bridge |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **DeepSeek Harness** | `dsh` | `dsh --profile headless "task"` | `--json` (NDJSON) | `--session-id <id>` | `~/.dsh/sessions` (JSONL) | DeepSeek API key | MIT | SDK JSON-RPC + ACP + Python SDK | **Integrate** — best documented. Dev preview |
| 2 | **Antigravity CLI** | `agy` | `agy -p "task"` | `--output-format json\|stream-json`, `--json-schema`, stdin streaming | `-c` / `--conversation <id>` | cache only; history server-side | Google OAuth keyring, `GEMINI_API_KEY`, ADC | No | Python SDK | **Integrate only via API key** — Google says wrapping `agy` is unsupported on consumer plans |
| 2b | **Antigravity App/IDE** | — | none | none | GUI picker only | none | Google/Enterprise OAuth | No | IDE extensions | **Cannot integrate** |
| 3 | **Cursor CLI** | `agent` | `agent -p "task"` (+`--force` to apply) | `--output-format json\|stream-json` | `--resume [chatId]`, `--continue`, `agent create-chat` | only `~/.cursor/cli-config.json` verified | login or `CURSOR_API_KEY` | No | `agent acp` | **Integrate**; verify transcript paths on a real install |
| 4 | **GitHub Copilot CLI** | `copilot` | `copilot -p "task"` | `--output-format=json` (JSONL), `-s` | `-r/--resume[=v]`, `--continue` | `~/.copilot/session-state/` + SQLite | Copilot sub or PAT (`Copilot Requests`) | Source-available | `--acp --stdio`, container server | **Integrate** — very strong |
| 5 | **Gemini CLI** | `gemini` | `gemini -p "task"` | `-o json\|stream-json` | `--resume`/`-r`, `--list-sessions` | `~/.gemini/tmp/<hash>/chats/` | API key / enterprise only | Apache-2.0 | subprocess | **Integrate only for enterprise/API-key users**; consumer ended 2026-06-18 |
| 6 | **Aider** | `aider` | `aider --message "task"` `--yes` | **none** | `--restore-chat-history` | project dotfiles (`.aider.chat.history.md`) | API keys | Apache-2.0 | subprocess | **Possible but text-only output** |
| 7 | **Amp** | `amp` | `amp -x "task"` | `--stream-json` (needs `-x`) | `amp threads continue T-…` | none local (server-side threads) | login or `AMP_API_KEY` | No | `@ampcode/sdk` | **Integrate**, cloud-dependent |
| 8 | **Cline** | `cline` | `cline --json "task"` | `--json` (NDJSON) | `--id <session-id>` | `~/.cline/data` + `sessions.db` | `cline auth` / key | Apache-2.0 | `@cline/sdk`, `cline --acp` | **Integrate** — strong |
| 9 | **Roo Code** | `roo` | `roo --print "task"` | `--output-format json\|stream-json` | `--session-id`, `-c` | `~/.roo`, `~/.vscode-mock/global-storage/tasks` | API keys | Apache-2.0 | CLI only | **Conditional** — extension shut down 2026-05-15 |
| 10 | **OpenCode** | `opencode` | `opencode run "task"` | `--format json` | `--continue`, `--session <id>`, `--fork` | `~/.local/share/opencode/opencode.db` | login or provider keys | MIT | HTTP server + SDK + ACP | **Integrate** — top tier |
| 11 | **OpenHands** | `openhands` | `openhands --headless -t "task"` | `--json` (JSONL) | `--resume [ID]`, `--last` | `~/.openhands/conversations` | cloud login or BYO key | MIT | REST SDK, ACP | **Integrate** with care — CLI unmaintained |
| 12 | **Continue** | `cn` | `cn -p "task"` | `--format json` | `cn --resume`, `--fork` | `~/.continue/sessions/<uuid>.json` | key in `config.yaml` (docs stale) | Apache-2.0 | `cn serve` HTTP | **Integrate cautiously** — repo read-only |
| 13 | **Windsurf** | — | **none** | none | none | `~/Library/Application Support/Devin/`, `~/.codeium/` | subscription/IDE | No | hosts ACP only | **Cannot integrate** |
| 14 | **Devin** | `devin` | `devin -p "task"` (+`--respect-workspace-trust false`) | no JSON for `-p` (metadata cmds only) | `-c`, `-r <id>` | docs confirm only `~/.local/share/devin/cli/logs/` | `devin auth login` | No | `devin acp` | **Integrate** if you accept text-only `-p` |
| 15 | **Factory Droid** | `droid` | `droid exec "task"` | `-o json\|stream-json\|stream-jsonrpc\|acp` | `--resume`, `exec -s <id>` | `~/.factory/settings.json` verified | `FACTORY_API_KEY` | SDK Apache-2.0 | `@factory/droid-sdk`, daemon | **Integrate** — strong |
| 16 | **Qwen Code** | `qwen` | `qwen -p "task"` | `--output-format json\|stream-json`, `--json-schema` | `--continue`, `--resume <id>` | `~/.qwen/projects/<cwd>/chats` | QwenCloud/ModelStudio keys | Apache-2.0 | SDKs, `qwen serve` | **Integrate** — strong |
| 17 | **Kimi Code CLI** | `kimi` | `kimi -p "task"` | `--output-format stream-json` | `-c`, `--session <id>` | `~/.kimi-code/sessions/<ws>/<id>/` | `kimi login` or API key | MIT | REST/WS, ACP | **Integrate** — strong |
| 18 | **Grok Build (xAI)** | `grok` | `grok -p "task"` | `--output-format plain\|json\|streaming-json` | `-r <ID>`, `-c` | `~/.grok/sessions/` | `grok login` or `XAI_API_KEY` | No | `grok agent stdio` (ACP) | **Integrate** — strong |
| 19 | **Zed** | `zed` | **none** | none | none | `~/Library/Application Support/Zed` (threads DB unverified) | GUI sign-in | GPL-3.0 | being an ACP agent | **Cannot drive Zed**; could serve Zed via ACP |
| 20 | **Replit Agent** | — | **none** (MCP only) | MCP JSON only | none | none (cloud) | MCP OAuth / `rpl_` admin key | No | MCP client | **Cannot integrate locally** |

### Ranking for this app, by integration cost

1. **Tier 1 — clean subprocess contract with JSON + resume + readable local state:** DeepSeek `dsh`,
   GitHub Copilot CLI, Cursor `agent`, OpenCode, Qwen Code, Kimi Code CLI, Grok Build, Factory Droid,
   Cline, OpenHands.
2. **Tier 2 — works, with a caveat:** Antigravity CLI (licence/consumer-plan limit), Gemini CLI (enterprise
   entitlement only), Aider (text-only output), Amp (server-side threads), Continue (repo read-only),
   Roo Code (project wound down), Devin (`-p` has no JSON).
3. **Tier 3 — no automatable local surface:** Antigravity App/IDE, Windsurf, Zed (as a target), Replit Agent.

### Cross-cutting hazards worth encoding in the bridge

- **Silent-failure shapes.** Antigravity headless soft-denies unapproved tools and still exits 0 (read stderr).
  Cursor emits **no well-formed JSON** on failure and just exits non-zero. DeepSeek headless prints only the
  final text unless you pass `--json`.
- **Approval/tool-permission flags are the real integration surface, not just `-p`.** Cursor needs `--force`
  to apply edits in print mode; DeepSeek has `--permission-mode` / `--approval-policy`; Antigravity has
  `permissions.allow` or `--dangerously-skip-permissions`; Aider needs `--yes`; Cline `--auto-approve`;
  Copilot CLI **denies** any approval request it cannot get in non-interactive mode unless you pass
  `--allow-all-tools`, scoped `--allow-tool=…` filters, or `--assisted-approval`.
- **Flag interactions bite.** Copilot's `--trust-folder` cannot be combined with `--resume`/`--continue`/
  `--session-id`; Devin's `-p` fails outright in an untrusted directory unless you add
  `--respect-workspace-trust false`; Cursor's `--output-format` is only valid with `--print`.
- **Read a tool's exit codes, not just its JSON.** Gemini CLI and Copilot's `workflow run` publish exit-code
  tables (0/1/42/53 and 0/1/2/130 respectively) that are the cheapest correctness signal a bridge can wire up.
- **ACP is emerging as the standard embedding protocol.** Documented ACP/stdio servers: `dsh --profile acp`,
  `agent acp`, `copilot --acp --stdio`, `cline --acp`, `opencode acp`, `openhands acp`, `devin acp`,
  `grok agent stdio`, `droid ... acp`, `kimi` ACP. If the app wants one protocol instead of ten parsers,
  implement an **ACP client** and keep a per-tool fallback for JSON-stream-only tools (Antigravity, Qwen, Kimi
  `-p`, Amp).
- **Session files are not a portable interface.** Only DeepSeek (`~/.dsh/sessions` JSONL), OpenCode
  (`opencode.db`), Cline (`sessions.db`), Continue (`~/.continue/sessions/*.json`), Qwen
  (`~/.qwen/projects/...`), Kimi (`~/.kimi-code/sessions/...`), Grok (`~/.grok/sessions/`), Copilot
  (`~/.copilot/session-state/`) and OpenHands (`~/.openhands/conversations`) have documented local stores.
  Cursor, Antigravity, Amp and Devin are server-side or undocumented — drive those by resumed session **ID**,
  not by file.
- **Three of the twenty had no automatable surface at all** (Antigravity App, Windsurf, Replit Agent) and one
  (Zed) is a GUI host that speaks ACP rather than a drivable agent.

### Corrections the verifier pass caught (kept here so they are not reintroduced)

- DeepSeek: `--resume` is **not** a `dsh` flag (only `--session-id`); the help text's `dsh tui --resume` is an
  app-argument illustration.
- Cline: `cline history --session-id <id>` does not exist; `providers.json` is under `~/.cline/data/settings/`.
- Zed: the claimed hidden `zed --printenv` does not exist.
- Qwen Code: `--json-schema` is the structured-output flag; `--output-format` is the format selector.
- Antigravity: a claimed `updater/update.lock` file and a named Keychain item were inventions; the App is not
  "no programmatic interface" — the SDK exists.
- Cursor: the "verified against Cursor 3.5.38" transcript path and the staff-attributed `store.db` segments were
  unverifiable as stated, and are marked unverified above.
- Windsurf/Zed/Roo/OpenHands/Devin/Factory: several candidate storage paths (`~/.factory/sessions`,
  `conversations/<id>/conversation.json`, `credentials.toml`, `threads/threads.db`) are third-party or
  unstated, and are labelled unverified.

### Research-tooling caveats (affects reproducibility, not the facts above)

- `web_search` was broken in this session (no DeepSeek API key), so all discovery went through
  DuckDuckGo Lite via `web_fetch`. DuckDuckGo intermittently served a bot CAPTCHA to a subagent mid-run.
- The first fan-out (40 agents, 20 tools) returned a value that the runtime **truncated at ~50 KB**, so the last
  8 tools were re-run as a second workflow (16 agents) with tighter word limits. If this survey is extended,
  cap each agent's returned record and keep the batch small.
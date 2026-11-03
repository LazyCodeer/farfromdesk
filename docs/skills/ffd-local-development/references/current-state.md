# Snapshot as of 31 October 2026

**Read the last section first.** The snapshot summary below is from 31 October and
the numbered sections after it supersede it one build at a time. As of 3 November
the current source is `/private/tmp/ffd-pr` (a real checkout on branch
`codex/local-desktop-work`, shared with other sessions), and the installed Local
app is **2392** (`local-local-tool-guards-2392`, installed 2026-11-04 03:37, health 401
after 28s). 2392 carries the read-only `notes_find` tool, the read/write split, the embedding
doc-vector cache (28 lines on a cold turn, 1 after), the plan-argument guard, and
locale-proof calendar dates.

## Source and installation

Actual current Local source: `/private/tmp/ffd-pr`

A real Git worktree on branch `codex/local-desktop-work` (PR #49), shared with other sessions, so check `git status` there before building and never reset it or assume its edits are committed. This supersedes the `/.local/social-session-wiring-20261031` snapshot named in earlier revisions of this file, which is no longer the source any build comes from. `ffd status` reports which checkout a build actually used.

Installed testing app: `/Users/sagar/Applications/FarFromDesk Local.app`
Bundle ID: `com.codecylabs.farfromdesk.localtest`
Last installed version: **2385** (`local-local-app-tools-2385`)
Backend build ID: `local-local-app-tools-2385`
The UI/backend/helpers were observed running from that path. Unauthenticated loopback health returned 401 as expected; this alone does not verify authenticated owner features. The isolated package smoke did verify authenticated startup.

Main app: `/Users/sagar/Applications/FarFromDesk.app`, untouched by this work.
Local backend port: 47961.
Local app state is separate. Do not open its private data or credentials merely to verify startup. Both Local and production may run, so never use broad process-name kills or guess which port is Local.
Codex uses the owner's normal `/Users/sagar/.codex` profile, not an isolated profile. Do not silently separate login/session discovery again. Tests must still use isolated synthetic provider homes.

## Installed skills

- Developer handoff: `~/.codex/skills/ffd-local-development`. Claude discovery: `~/.claude/skills/ffd-local-development` is a symlink to the same canonical skill.
- Creative runtime: `~/.codex/skills/ffd-social-creative`; source in `skills/ffd-social-creative` within the Local source. It is bundled in app backend resources and delivered by request-bound runtime tools. Do not assume Claude reads Codex's global skills folder.
- Developer skill source copy: `docs/skills/ffd-local-development` in the Local source. Keep this outside runtime `skills/` to avoid bloating Social agent prompts.

## Evidence and recoverable work

Artifacts under `/Volumes/Personal/Developer/FarFromDesk/Builds/`:
- `social-skill-provider-20261031`: portable creative skill ZIP, actual JPEG examples, skill/source validation notes, source delta archive, prior 2312 rollback bundle.
- `social-day-cards-20261031`: daily calendar, image settings, coloured logos, chat polish; rendered screenshots, results, source delta archive, prior 2313 rollback bundle.
- `social-complete-cards-20261031`: full card captions, equal image areas, stable thumbnail cache and quiet refresh; screenshots, results, source delta archive, prior 2314 rollback bundle.

The implementation-source ZIPs contain selected changed files, **not complete standalone repositories**. Build from the actual Local source. Rollback bundles contain app resources, not private app state. Do not distribute bundles or source archives without checking their contents and the task's sharing scope.

## What is not established

No live Meta image request or live native-session generation was run during builds 2313–2315. Native-session routing and Meta transport were tested with synthetic fixtures; standalone local SVG/JPEG generation was actually rendered. Owner image quality feedback remains the acceptance test. No social publishing, live email sending, public release or production deployment occurred.

Ideas/Brand UI includes explicitly unconnected states. Do not describe a persisted brand asset library, rendered video generation, unrestricted website access or all earlier PRs as complete based on this handoff. Recheck their own implementation and evidence if asked.

Developer skill validation: frontmatter/naming checks, relative-link checks, metadata inspection, non-Local rejection using a synthetic bundle, and isolated packaged smoke all passed when this skill was created.

## Manual sharing follow-up
Sharing source/tests are complete; see [social-sharing.md](social-sharing.md). Local was observed at2317 on this turn. Build2318 compiled successfully but was not installed here. Layout thread 01a191bf-1a52-7a13-9376-f14d3b696889 owns the next clean combined build/install after its concurrent2319 build settles; re-inspect installed metadata before acting.

## Combined Local 2320 update

Installed and launched 31 October 2026, preserving both Social layout and manual sharing work. Notice spacing tightened and highlighted; card content selects drafts; carousel arrows/count overlay media; actions are header icons. Duplicate calendar labels removed. Platform filters expand labels/counts on hover/focus. Search/sort are beside tabs with responsive fallback and persistent queries. Manual sharing includes complete carousel export and the macOS chooser; see social-sharing.md for destination limitations.

Validation: 35 focused tests passed, one existing conditional test skipped; targeted analyzer clean, release build passed. Staged signature and isolated backend smoke passed. Installed UI/backend process paths and unauthenticated loopback 401 verified. Live destination posting, receiving apps and native share chooser were not exercised. Production app and data untouched.

Artifacts: /Volumes/Personal/Developer/FarFromDesk/Builds/social-notice-20261031. External recovery: local-2317-rollback.bundle. Sharing recovery: sibling social-manual-share-20261031. Source remains the shared ignored snapshot above.

## Caption-only cards, Local 2321

Installed and launched on 31 October 2026. All draft cards now expose share/copy/export/delete; actions load and check the exact target ID before using it, and failed or cancelled switches cannot act on the previous card. Only caption text remains below media; stored title, brief, prompts and source metadata remain intact. Carousel count is x / y. Missing/invalid images retain an in-image notice and unavailable export is disabled for the selected draft.

Validation: 32 existing Social tests plus 5 card-action regressions and 1 visual review passed (one existing conditional test skipped). Targeted analyzer clean. First release compiler stalled; terminated only that build and retry succeeded. Signed package and isolated backend smoke passed. Installed process paths and unauthenticated 401 verified. Artifacts/2320 recovery bundle: /Volumes/Personal/Developer/FarFromDesk/Builds/social-caption-cards-20261031.

## Social routing modes, Local 2322

Installed and launched 31 October 2026. Backend-only update preserves the UI executable and App.framework from 2321. Agent names/absolute instruction-file paths replace full prompts in native envelopes and managed provider start/resume. Explicit executor switches preserve Social/image source; new authenticated creation requests activate Social when no mode is selected. New phone modes inherit the saved image preference. Meta rejects SVG-only rendering; creative guidance remains useful for layout and hybrid composition. Brain carries mode/provider into native tasks and rejects routing results after executor/mode changes.

242 focused automated tests passed across 21 files; TypeScript build, signature, isolated packaged startup smoke, installed version and Local UI/backend executable paths verified. Live native/Meta generation was not run. The audit of 22 session requests and 15 command records is in social-request-audit-20261031/AUDIT.md. Browser composer autofill with text and images is still pending; existing share actions retain their documented limitations.

Artifacts and external 2321 rollback: /Volumes/Personal/Developer/FarFromDesk/Builds/social-routing-modes-20261031. See RESULTS.md, tests.log, stage.log and installation.json. Source is still the shared ignored snapshot; changes are not a committed PR. Other chat 01a191bf-1a52-7a13-9376-f14d3b696889 was coordinated with; preserve both its UI changes and this backend work.

## Social chat previews, Local 2323

Installed and launched 31 October 2026, preserving the 2322 UI resources. New final Social replies queue saved images as Telegram photos or WhatsApp inline JPEGs, with platform caption and ordered carousel slides. Long captions follow as complete text. This affects phone chat previews, not the desktop Inbox media viewer. No historic draft replay or real message send was performed during testing.

Preview/transport suite: 110 passed, 1 existing conditional skip. Additional overlapping regression suite: 95 passed, including uncertain-send protection. TypeScript build, signature and isolated package startup passed. Installed2323 UI/backend/helper paths and loopback401 verified after startup exceeded the installer's initial15-second wait. External2322 rollback remains; temporary install rollback removed only after verification.

Production audit: stopped app2310/backend0.9.9,468 tracked requests,33 command-response records, read-only without credential access or data mutation. Parent request650 was blocked for implementation screenshots but its child sent six reference-image documents. Monitor575 remains submitted despite60 replies and a later confirmed stop; zero replies followed the stop. Do not restart it. Full report and installation evidence: /Volumes/Personal/Developer/FarFromDesk/Builds/social-chat-previews-20261031.

## Server mode, lid closed: Local 2325

Installed and launched 1 November 2026, replacing 2323. A brief 2324 install was superseded the same day by 2325, which only adds honest reporting when the helper does not take effect. Source remains the shared ignored snapshot; nothing here is committed.

Feature: Settings -> "Keep running with the lid closed", off by default. Turning it on asks for one administrator approval, installs a root LaunchDaemon helper, and from then on keeps system sleep disabled while FarFromDesk is alive and the Mac is on power, including with the lid shut. Turning it off needs no approval: the helper restores normal sleep itself within about five seconds.

- Helper source: `native/server-mode/helper.sh`; installed to `/Library/Application Support/FarFromDesk/server-mode/helper.sh` (root:wheel, 755).
- Daemon: `/Library/LaunchDaemons/com.codecylabs.farfromdesk.servermode.plist`, label `com.codecylabs.farfromdesk.servermode`, RunAtLoad + KeepAlive, logs to `/var/log/farfromdesk-servermode.log`.
- Intent + heartbeat: `<state>/server-mode.json`, mode 0600, written by the backend every 20s. The helper ignores it unless it is owned by the installing uid and parses.
- Decision, every 5s: `pmset -a disablesleep 1` only when the setting is on, the heartbeat is younger than 300s, and `pmset -g batt` reports AC power. Every other condition runs `disablesleep 0`: setting off, backend stopped or crashed, app removed, battery, wrong owner, malformed state, stale heartbeat after a reboot, helper unloaded.
- The app never calls pmset as root. It writes state, reads `pmset -g` without privileges, and reports what the system actually says.
- App Nap: the runner holds one `beginActivity(.userInitiatedAllowingIdleSystemSleep)` while server mode is active, through channel `farfromdesk/server-mode`. This keeps timers running; it does not affect sleep policy.
- Thermal safety is the on-power rule only. There is no temperature check, so a closed Mac on power can run warm; the UI says to keep vents clear.

Verified: 13 new backend tests (helper decision matrix against a fake pmset, install/rollback/heartbeat/remove state machine), 50 desktop widget tests including the settings pane, targeted analyzer clean, TypeScript build, ad-hoc signature, isolated packaged smoke, installed 2325 process paths and loopback 401.

Owner-verified on 1 November: the administrator install completed (plist present as root:wheel, daemon running under launchd), and toggling the setting set SleepDisabled 1 and back to 0 within seconds, on AC power. Log evidence: `/var/log/farfromdesk-servermode.log` entries at 10:04:26Z, 10:04:52Z, 10:04:57Z and 10:05:08Z on 1 November.

Superseded on 3 November: the lid-close run is now verified (2377), as is the battery-to-AC transition in both directions with real sleep events in `pmset -g log` (2377). Heat behaviour is still only a design claim, not a measurement. `pmset disablesleep` remains an undocumented switch absent from `man pmset`; if Apple removes it the settings pane reports "The sleep helper is not taking effect" instead of pretending to work. See the 2377 and 2379 sections below and `docs/remote-control-lock-screen.md`.

Current machine state after the 2325 work: the helper is installed and loaded, and it is inert whenever the setting is off. See the 2326 section for the state after the owner turned server mode on. Rollback: `local-2323-rollback.bundle` and the staged `stage/FarFromDesk Local.app` in `/Volumes/Personal/Developer/FarFromDesk/Builds/server-mode-20261101`.

## Offline channel recovery, Local 2326

Installed and launched 1 November 2026 over 2325. Two fixes for a saved Telegram bot that fails to connect at launch.

- **Setup is no longer re-entered for an offline channel.** `connected` meant "the socket is up", so any failed connect reopened the four-step wizard at Step 2 even though the bot and owner were confirmed. `channelConfigured` now means "credentials saved and owner confirmed" (Telegram: `configured` and `ownerId`; WhatsApp: `phoneNumber`). The wizard appears only when the channel genuinely needs setup, or when the owner opens it from the new banner.
- **An offline but configured channel shows the app plus a banner** (`channel-offline` key): "<channel> is offline. Your setup is saved and FarFromDesk keeps retrying.", with `Retry now` (POST `/api/telegram/connect` with no token, which reuses the saved token) and `Setup`, which reopens the wizard on request.
- **Launch-time connect failures retry by themselves.** `Telegram.resume()` schedules a backoff retry (30s doubling to a 5 minute cap, six steps) for transient failures such as the generic `TelegramError(0)`, and does not retry 401, 403 or 409, which need the owner. A successful connect cancels the timer and resets the count; `close()` cancels it on shutdown. The retry base delay is injectable for tests.
- The setup card badge now reads "Not connected · bot saved" when a token is saved, instead of implying a fresh setup.

Verified: `test/telegram.test.ts` 47 passed including three new retry tests (transient retries, 401 does not, no bot stays quiet); `test/server-mode.test.ts` 13 passed; full backend suite 1602/1612 with 6 failures in `app-updater`, `coordinator-experience`, `managed-collaboration`, `notification-route` and `proof-contract-scope`, none of which import the changed modules (one failure is `sandbox-exec: sandbox_apply: Operation not permitted` from the nested test sandbox). Desktop: `settings_design_test.dart` 6 passed including two new gate tests, `widget_test.dart` 51 passed; full desktop suite 160 passed with 2 stale `social_preview_test.dart` assertions on the text "0 drafts", which the calendar no longer renders (pre-existing, unrelated to this change).

Live verification at 16:04 on 1 November: after installing 2326 the backend resumed the saved bot by itself at launch, with no click. `lsof` shows an ESTABLISHED connection from the Local backend to `2001:67c:4e8:f004::9:443`, `telegram-token` was rewritten at 16:04:16, and `telegram-offset:8856686568` advanced, which means the update poll is running.

## Reply format, Local 2327 (1 November 2026)

Installed and launched from the shared snapshot. Every assistant reply now leads with the
answer and trails provenance as a two-line tail: `✳️ Provider: Claude Desktop` then
`💬 Session Name: <chat title>`, with `🔖 #N` appended when the reply belongs to an item.
Continuation bubbles inside a ten minute run carry only `✳️ Claude Desktop · 🔖 #N`.
The `— FarFromDesk` footer and the per-message `Mode:` line are gone; receipts and notices
are one plain line and never wear the session's voice. A submitted request that goes quiet
gets one notice at 75 s and one escalation at about five minutes. Repeating the same words
while the first copy is unanswered is rejected instead of queued again. Auto-close now tells
the owner. Backend telemetry adds `delivery_accepted`, `silence_notice` and `silence_escalated`.

Validation: `tsc --noEmit` clean, `npm run build` clean, full suite 1606 pass with the same 6
pre-existing failures as the pre-change baseline and no new ones. Four new tests in
`test/receipt-honesty.test.ts`. Staged ad-hoc signed, `codesign --verify --deep --strict`
passed, isolated packaged smoke passed. Installed bundle 2327, backend build ID
`local-chat-format-2327`; backend process running from the installed path and unauthenticated
loopback returned 401. Live WhatsApp rendering was not exercised by this build step.

**Startup trap hit during install:** the Local app refused to start its backend because
`assertLocalStateSafe` (`desktop/lib/local_state_guard.dart`) rejects any symlink in Local state
outside its whitelist, and `home/.cache/codex-runtimes/...` held three dangling links into a
deleted `/private/var/folders/...` temp directory. Removing the dangling links restored startup.
The guard should skip broken links instead of failing closed; that fix is not applied yet.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/chat-format-2327/local-2326-rollback.bundle`.

## Liveness fix, Local 2328 (1 November 2026)

An owner message at 17:53 was answered by Codex Desktop while the bridge told the owner
"Codex Desktop is closed. Queued; it answers when the app opens." The liveness probe matched
the executable path `Codex.app/Contents/MacOS`, but the Codex desktop app ships as
`ChatGPT.app` with bundle identifier `com.openai.codex`, so the probe never matched and every
receipt claimed the app was closed.

Fix: `src/app-liveness.ts` now reads one `lsappinfo list` per maintenance tick and matches
bundle identifiers (`com.openai.codex`, `com.anthropic.claudefordesktop`/`com.anthropic.claude`),
reporting running when the probe cannot tell. The specialty line also moved into the metadata
tail as `🎨 Mode: ...`, shown only when it changes.

Validation: full suite 1608 pass, 5 fail, no new failures against the pre-change baseline;
backend rebuilt; staged, ad-hoc signed, verified and smoke-tested; installed as 2328 with backend
build ID `local-chat-format-2328`; installed backend running and `app-running:codex` reads true
while Codex Desktop is open. Live receipt wording was not exercised by this build step.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/chat-format-2328/local-2327-rollback.bundle`.

## Honest receipts under a quitting app, Local 2329 (1 November 2026)

At 18:06 an owner message arrived while Codex Desktop was quitting and the receipt still read
"⏳ Queued for Codex Desktop. Waiting for it to start." The receipt never asked the app
anything: it read `app-running:<provider>`, which only the 60 second maintenance tick refreshes.
macOS began terminating `ChatGPT` (pid 48403, bundle `com.openai.codex`) at 18:06:45 and marked
it automatically terminable at 18:06:55; the message landed at 18:06:58, so the cache still said
running. The next tick flipped it to false, which is why the stored value is false now.

Fix: `probeDesktopAppsNow()` in `src/app-liveness.ts` is a synchronous `lsappinfo` read (28 ms,
no timer) and `Router.receiptWithLiveness` calls it once per owner message, so the receipt
describes the app at the moment it is written. `recordLiveness` also stamps
`app-running:<provider>:at`, and a true to false transition while a request is still waiting
emits one `📴 ... closed since. Your message stays queued and runs when the app reopens.`
instead of leaving "queued" as the last word. Tests pin `router.livenessProbe` so receipt text
never depends on which apps happen to be open.

Validation: full suite 1601 pass, 12 fail. All 12 are the pre-existing families (role bootstrap
wording, staged handoff, approval provenance, nested-sandbox extraction, and errand/profile
provenance); none touch the receipt or liveness paths, and the errand failures live in files
that never import the router. The 5-failure baseline recorded for 2328 understated this suite.
Staged, ad-hoc signed, verified, installed as 2329 (`local-liveness-receipts-2329`), backend
running, health 401, `app-running:codex` false while Codex Desktop is closed. A live receipt was
not exercised by this build step.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/liveness-receipts-2329/local-2328-rollback.bundle`.

## Muse Code CLI, Local 2330 (1 November 2026)

Meta's coding agent is Muse Code (`curl -fsSL https://dev.meta.ai/install.sh | sh`), binary
`~/.local/bin/muse`, installed here at 1.4.14. It is not a provider in the app yet. This build
adds the runtime and one owner command.

`src/muse-session.ts` runs one headless turn with `muse exec --json --disable-approval
--approval-mode never`, parses the JSONL records and resolves on `run.terminal.completed`, so a
run that did not finish is an error rather than an answer. Text comes from the terminal record,
falling back to accumulated `run.output.delta`; `run.usage` supplies tokens and the resolved
model. Runs are killed by process group on timeout, abort or oversized output.

`/muse <task>` in `src/owner-commands.ts` runs in the folder of the session you are talking to
(or `muse-workspace`), continues one Muse session per folder and resumes it through
`--session-id`, stores it in `muse-session:<cwd>`, and `/muse reset` starts a fresh one. The
command is auth-gated by the same owner check as every other slash command.

Validation: 7 new tests in `test/muse-session.test.ts` (complete, failed terminal, empty answer,
early exit with reason, missing binary, timeout, argument shape), `test/whatsapp-owner-commands`
and `test/message-options` still green. Packaged smoke: the shipped `dist/muse-session.js` run by
the app's bundled node returned "muse live" from `muse-spark-1.3-contributor` in 21 s (26,851
input / 17 output tokens). Installed as 2330 (`local-muse-command-2330`), backend running, health
401. A WhatsApp `/muse` message was not exercised.

Not done: Muse is absent from Coding platforms, so it cannot be a binding, coordinator or
receipted provider yet. That needs a platform entry in `masters.platforms`, connection routes for
`provider:'muse'`, and receipts/icons (`src/coordinator-experience.ts` maps claude to ✳️ and
everything else to 🤖).

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/muse-command-2330/local-2329-rollback.bundle`.

## 2331 — Muse Code as a full provider (`local-muse-provider-2331`)

Muse Code is now a third selectable provider, CLI only, alongside Codex and Claude. One binding
owns exactly one Muse session; the session id is real (it appears in `~/.local/share/muse/`,
so `muse resume` sees it) and is stored per binding as `muse-session:<bindingId>` after the first
turn, then passed back with `--session-id` so later messages continue the same conversation.

Backend: `Provider` includes `muse`; `native.catalog/validate` take any provider and `museCatalog()`
reads `~/.local/share/muse/session-index.db` read-only for discovery; `connections.ts` probes the
binary and `~/.config/muse/auth.json` for a single CLI profile and refuses a desktop route;
`masters.ts` adds the platform card (availability from `muse --version`) and a dispatch branch that
runs `runMuse` and delivers through `channelReply` on `run.terminal.completed` only; receipts use 🧠
and "Muse Code"; liveness treats Muse as always online because there is no desktop app; the brain
routing policy accepts it.

Desktop: three-way `providerLabel`/`providerBrand` in `desktop/lib/connection_status.dart`, Muse rows
driven entirely by `/api/master-options` (never invented), no desktop affordances, 🧠 glyph, no new
assets. Built with the Local dart-defines; `flutter analyze` clean apart from one pre-existing info.

Validation: `tsc` clean; backend suite 1611 pass / 13 fail, where 12 are the known baseline and the
13th (`speech-bundle.test.ts fresh installation`) is a pre-existing snapshot inconsistency, proven
unrelated (it fails with Pass B's `app.dart` reverted and the file is untouched since Oct 30).
Flutter: `flutter test` 162 pass / 2 fail, both `social_preview_test.dart`, both proven pre-existing
by reverting Pass B's `app.dart`. Five stale lowercase session labels in three test files were updated
to the new capitalised form ("Alpha · Codex · native-a"), which is the intended behaviour change.

Installed as 2331, backend running (health 401). Not exercised: a live WhatsApp message to a Muse
binding, and the create-from-Coding-platforms flow.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/muse-provider-2331/local-2330-rollback.bundle`.

Build gotcha: a Local shell must be built with `--dart-define=FFD_ISOLATED_LOCAL=true` and the state,
port and codex-home defines (`docs/skills/ffd-local-development/references/build-install.md`). Without
them the shell runs in production mode and never starts its backend. Staging must also carry forward
`Contents/Resources/speech` and the whole installed `backend/` (node_modules, native, runtime): both
are produced outside `flutter build`.

### 2331 follow-up — Muse reported "signed out" inside the packaged app

Muse showed up in `/api/master-options` with `available:false`, reason
`Muse Code signed out · sign in to this CLI`, and 0 sessions, so it never reached the UI's
"Detected apps" list (which filters on `available == true`).

Cause: the Local backend runs with an isolated `HOME`
(`…/FarFromDesk Local/home`), so Muse's credential and session index were being looked up under
that private home, where neither exists. A healthy signed-in install therefore looked absent.
Codex already avoids this through `FFD_SELECTED_CODEX_HOME`; Muse had no equivalent.

Fix: `src/muse-paths.ts`. When `FFD_ISOLATED_LOCAL=1`, Muse paths resolve through
`os.userInfo().homedir` (the owner's real home, independent of `HOME`); otherwise `HOME` is
honoured as before, and explicit `MUSE_CONFIG_DIR` / `MUSE_DATA_DIR` / `MUSE_BIN` always win.
`connections.ts`, `native.ts` and `muse-session.ts` all route through it, so there is one source
of truth for Muse paths. Regression test: `test/muse-paths.test.ts` (3 cases).

Verified live after install: `muse | cli | Muse Code | available=True | reason=None | sessions=7`,
including the two-turn continuity session.

Install gotcha: replacing the bundle fails with "Operation not permitted" while the app is still in
use, and a partial `rm -rf` then leaves a broken app. `install-2331.sh` now waits until the bundle
is really gone, aborts loudly if it cannot be removed, and verifies `Info.plist` after copying.

## 2332 — coordinator setup page redesign (`local-setup-page-2332`)

The "Add a coordinator" page was rebuilt around the choice the owner is actually making.

- The dialog no longer repeats its own heading, and the "Back to coordinators" button is gone
  (the close control already covers it). The card keeps only the form and its action.
- Mode first: a two-part switch, "New coordinator" | "Use an existing session · N", sits at the top
  and only the chosen path renders below. Previously both shared one column, so a session list
  appeared under a primary action that said "create".
- **Project picker.** The page now offers the folders each CLI has actually run in, most recent
  first, and sends `workspaceId` — which the UI never did before, so every coordinator landed in a
  synthetic `~/.farfromdesk/coordinators/…` folder. This is also what decides which project skills
  and rules a Muse turn loads. Restricted to CLI platforms: a desktop coordinator keeps its own
  folder and opens its own chat there.
- **Muse trust.** Muse runs headless with no trust prompt, so "Load this project's rules and skills"
  is chosen on this page and stored as `muse-trust:<bindingId>`; the run then passes
  `--trust-workspace` or not. Creation-time only for now; changing it later needs an endpoint.
- State language: "App · Ready" / "Terminal · Ready" / "Needs setup", with the reason in the detail
  line instead of an orange diagnostic where a state word belongs. Rows say "Use this session"
  (CLI) or "Native session" (desktop), the header says "N saved sessions", a Muse row shows the
  model it will continue, and the Muse page no longer talks about desktop accounts.
- Muse Code is named without a redundant "CLI" suffix, and its mark renders at 0.62 of the tile so
  it reads as a mark rather than a pink blob next to the Claude and Codex logos.

Backend: `rows()` carries `model`; `create` takes `trustWorkspace`; workspace discovery falls back
to the folder the CLI reported when the scanner cannot run (its permission failure previously
emptied the list, which would have made the picker dead on arrival); coordinator folders and system
temp folders are excluded from the project list via `isCoordinatorFolder`/`isScratchFolder`, matched
independently of which home made them, because the backend runs with an isolated `HOME`.

Validation: `tsc` clean; backend 1615 pass / 13 fail (the 12 known plus the pre-existing
speech-bundle snapshot inconsistency); Flutter 168 pass / 2 fail (both `social_preview_test.dart`,
proven pre-existing). New `desktop/test/coordinator_setup_page_test.dart` covers all six changes.
Verified live: muse available with 1 real project, codex 25 projects, no coordinator or temp noise.

Install gotcha: `ditto` is denied on this machine when writing an app bundle into `~/Applications`
(xattr/ACL writes), leaving a partial app, while `cp -R -P` copies the same bundle completely and
keeps its symlinks. `install-2332.sh` uses `cp -R -P`, verifies `Info.plist`, `Frameworks` and the
speech bundle, re-signs, and refuses to report success on a partial copy. Do not start a backend by
hand while the app is running: it takes the service lock and the app's own backend then exits in a
loop, which looks exactly like a crash in the new build.

## 2333 — coordinator wizard (`local-wizard-2333`)

The add-a-coordinator page is now the three-step flow: **Select type → Configure / Choose session →
Review**, matching the design reference.

- A "Coding app" row sits under the dialog heading on every step: logo, dropdown of every platform
  (ready ones first), a readiness pill ("Ready" / "App ready" / "Needs setup"), the account label
  from the connection probe, and "Check apps" on step 1 only.
- Step 1 offers the two paths as cards: "Add coordinator" and "Use existing session" with the count
  of available sessions. The dialog subtitle follows the step, so the body no longer repeats it.
- Step 2 is Configure (name, working folder chosen from the folders the app has worked in, and the
  Muse trust switch) or Choose session (search, radio rows with model, path, badge and relative
  age). Step 3 is a review card with chips for the app, folder, session and trust, then
  "Add coordinator" / "Replace coordinator".
- The stepper shows completed steps with a tick, and the footer is Back plus one primary action.
  A platform that is not ready stops the flow at Configure instead of offering a dead Add button.

State: `setupStep` (1-3) is reset every time the flow opens. Labels are unchanged in meaning, so
`submitMaster` and the create payload are the same as 2332, including `workspaceId` and
`trustWorkspace`.

Validation: `flutter analyze` clean apart from one pre-existing info; Flutter 169 pass / 2 fail
(both `social_preview_test.dart`, pre-existing). `coordinator_setup_page_test.dart` was rewritten
for the steps and now also walks type → configure → review and asserts the gate; four
`widget_test.dart` tests and two `coordinator_detection_test.dart` tests were updated to the new
navigation. Verified live: 2333 installed, backend healthy, projects still clean (codex 25,
muse 1, no coordinator or temp noise).

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/wizard-2333/local-2332-rollback.bundle`.

## 2334 — a select that matches the design (`local-dropdown-2334`)

Material's `DropdownButton` was wrong for this app: it installs a route that dims the whole window,
centres its menu away from the trigger, sizes rows to the text scale, and shows no brand marks.
`PopupMenuButton` had the same problem in the other direction and ran off the right edge of the
dialog. Both are gone from the coordinator flow.

`desktop/lib/ffd_select.dart` adds `FfdSelect<T>` / `SelectOption<T>`: the menu anchors directly
under its trigger, grows left when the trigger is near an edge (`alignRight`), caps at 300 px with
its own scroll, gives each option one compact row with its mark and an optional detail line, tints
the current row, and closes on Escape or an outside tap. Nothing is dimmed. The two wizard controls
now use it: the "Coding app" row (platform marks in the menu, state pill on the trigger) and the
folder chooser.

Gotcha worth remembering: an overlay menu sits above the dialog's `Material`, so `InkWell` throws
and the menu renders as nothing until the menu is wrapped in `Material(type: transparency)`. That
is what broke eight widget tests at first.

Install gotcha: `install-*.sh` aborted silently when the best-effort ad-hoc `codesign` failed under
`set -e`, leaving the new app copied but never launched, which reads exactly like a broken build.
Re-signing is now skipped with a note and the install continues; the signature is still verified.

Validation: `flutter analyze` clean apart from one pre-existing info; Flutter 169 pass / 2 fail
(both pre-existing `social_preview_test.dart`). Verified live: 2334 installed and healthy, custom
menu strings present in the shipped UI, production untouched.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/dropdown-2334/local-2333-rollback.bundle`.

## 2335 — the coding app becomes one control group (`local-detect-apps-2335`)

The "Coding app" row stretched its picker across the card, left a loose readiness badge between the
picker and the button, growing its menu wider than its own control. Now the picker is a fixed 300 px
at the right of the row, directly beside the detection button, and the menu is exactly the picker's
width, anchored under it (`alignRight`).

Readiness moved inside the control: the trigger carries the current app's state pill, and every
option row carries its own state (`Ready` / `App ready` / `Needs setup`) through the new
`SelectOption.trailing`, with the backend's `reason` as the row's detail line when the app cannot be
used. The caption under the row, naming the selected app's account, is unchanged.

`Check apps` is now `Detect apps` (busy label `Detecting…`) in the app row and in the Coding
platforms card, and the backend copy that told owners to click it moved with it: `src/native.ts`,
`src/connections.ts`, `src/workspace-scanner.ts`, `src/masters.ts`. No backend test asserted the old
wording.

Two new widget tests in `desktop/test/coordinator_setup_page_test.dart` pin the geometry (picker
300 px, an 8 px gap to the button, menu inset only by its own padding and border) and the
unavailable-row state with its reason; `SetupGateway` gained an `unavailable` platform key for it.

Validation: `flutter analyze` clean apart from one pre-existing info; Flutter 172 pass / 1 skipped /
2 fail (both pre-existing `social_preview_test.dart`); backend `tsc` clean and 1617 pass / 11 fail,
the same known set as before this change (the flaky `speech-bundle` case passed this run). Verified
live: 2335 installed, backend healthy, `Detect apps` present and `Check apps` absent in both the
shipped Dart AOT snapshot and the packaged backend, production untouched.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/detect-2335/local-2334-rollback.bundle`.

## 2336 — the coding app preferences flow (`local-coding-app-prefs-2336`)

The preferences were an `ExpansionTile` inside the Coordinators dialog that rendered a "Coding
platforms" panel of Material `DropdownButton`s saving on every change: reading the state and editing
it were the same gesture, the menu was the component this project already replaced elsewhere, and a
dialog inside a dialog was doing two jobs. It is now a row that opens its own panel.

`desktop/lib/screens.dart`: `codingAppPreferencesRow()` is the entry (laptop tile, title, one line of
description, chevron). `openCodingAppPreferences()` builds the panel: heading, subtitle, close, a
detection banner (`Detected N coding platforms` / `No coding apps found` with install links, and
`Detect again` / `Detect apps`), one card per app with its mark, name, mode line and readiness chip,
a `Preferred mode` `FfdSelect` (No preference / CLI / Desktop, each option carrying `Not detected` or
its connection status as detail), and a footer of the "No preference" note plus Cancel and Save
changes.

Editing is staged in a `draft` map, so opening the panel can no longer change anything: Save posts
only the providers that moved, closes the panel, and stays disabled until something changes; Cancel
discards. The count is apps, not runtimes, which is why the banner says `Detected 3 coding platforms`
while four runtimes exist.

Two honesty rules worth keeping:

- Detected and usable are different. A CLI that is installed but signed out reads
  `CLI needs setup` in the card line and shows the connection status in the menu, and the chip is
  `Needs setup` unless another mode of that app can actually be created.
- Muse Code has no desktop app and no `platform-preference` at all (`platformPreferences()` only
  reports codex and claude), so its card states `Always CLI` instead of offering a one-option select.

"No preference" is a real choice an owner may return to, so the endpoint learned to clear:
`masters.setPlatformPreference(provider,'none')` deletes `platform-preference:<provider>` and returns
the preferences, and an unknown provider is still refused rather than silently ignored. Without that,
a select offering "No preference" could only set a mode and never unset it.

Copy from the design was adopted for the page subtitle ("Choose who answers your messages and how
they work."), the "+ Add coordinator" description, and the preferences row. The design's back arrow
was not: the panel is a dialog over the Coordinators dialog, so the close icon already returns there,
which follows the earlier instruction to drop back buttons next to a close icon.

The old `FFD_CAPTURE_PLATFORMS` golden is gone: the panel lives in the app's overlay, not under the
`Scaffold`, so a `Scaffold` golden could never show it. (Text also renders as boxes in `flutter
test`, since the app's Onest/DMSans fonts are not the test font.)

Validation: `flutter analyze` clean apart from one pre-existing info; Flutter 178 pass / 1 skipped /
2 fail (both pre-existing `social_preview_test.dart`); backend 1618 pass / 11 fail, the same known
set as before. Three widget tests replaced the old preference test (staged save and no launcher
prompt, discarding on Cancel, explicit clear), and `test/masters.test.ts` gained the clear case.
Verified live: 2336 installed and healthy, panel strings present in the shipped Dart snapshot, the
clear path present in the packaged backend, production untouched.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/prefs-2336/local-2335-rollback.bundle`.

## 2337 — the real Muse mark and one vocabulary per runtime (`local-muse-logo-2337`)

Muse Code was drawn with a `🧠` glyph while Codex and Claude had real marks. The real one lives inside
the CLI: `~/.local/bin/muse-bin-<version>` embeds two PNGs (84x84, 56x56). The 84x84 plate is black
behind a blue chevron and a white M, so it was converted by unpremultiplying luminance into alpha
(black becomes transparent, colours survive), tight-cropped, padded 6%, and saved as
`desktop/assets/logo-muse.png` (68x68). `pubspec.yaml` lists assets one by one, so it had to be
declared, and a missing declaration shows up as `Unable to load asset` inside unrelated widget tests.

`logoTile`, `memory_panel` and `social_generate_dialog.sessionMark` now use that asset, and Muse's
tile is dark (`0xff1b1b20`) because the mark is white: on the old cream tile the M would have been
invisible. The glyph branch is gone from `logoTile` and the shipped binary carries no `🧠` at all.

One vocabulary per runtime. `runtimeReadiness(option)` returns `Ready`, `App ready` or `Needs setup`
and is now the only source for the wizard's pill, the picker menu's trailing word, the panel card's
mode line (`CLI needs setup · Desktop app ready`) and the panel's menu rows. Before this, the panel
invented `not detected` and `available` for runtimes the picker called `Needs setup`. The picker's
option detail also gained the same why the panel gives: `platformConnectionStatus` when the app is
present but unusable, the backend's `reason` when it is not detected at all.

Counts reconciled. The banner counts runtime rows — the exact list the coding app picker shows
(`Detected 5 coding runtimes`) — and names the app count separately (`In 3 apps, the same list the
coding app picker shows`). The old `Detected 3 coding platforms` counted apps while the picker listed
five runtimes, which is what looked wrong on screen.

The preference card is one compact row now: mark, name, readiness chip beside the name, the runtime
mode line under it, and the 250 px mode picker at the right end. The `Preferred mode` label is gone
(the footer note still explains "No preference"); connection label, readiness message and reason stay
under the row.

Validation: `flutter analyze` clean apart from one pre-existing info; Flutter 179 pass / 1 skipped /
2 fail (both pre-existing `social_preview_test.dart`). The preference tests were updated for the new
words, and a new one pins the agreement itself: the panel and the picker both say `Needs setup` and
both give `Terminal · Sign in required` for Claude's signed-out CLI. The backend was untouched this
round. Verified live: 2337 installed and healthy, `logo-muse.png` present in the shipped bundle, no
`🧠` in the shipped binary, production untouched.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/logos-2337/local-2336-rollback.bundle`.

## 2338 — the coordinator actions become one group (`local-coordinator-actions-2338`)

`Coding app preferences` was a full-width row under the coordinator list, with a laptop tile, its own
description and a chevron, so it read as a tab rather than an action. It is now a button, and it sits
to the left of `+ Add coordinator` with both pulled to the right edge of the row:

`[ description ...................... ] [ Coding app preferences ] [ + Add coordinator ]`

`codingAppPreferencesRow()` and the dialog-level block that rendered it are gone; the description
that used to sit to the right of the primary button now takes the left side (`Expanded`), so the two
buttons stay together. The `coordinator-coding-apps` key moved onto the new button, which is why the
existing tests kept finding it. The empty "No coordinators yet" box keeps both actions, preferences
first, since that is also where a fresh install would start; that branch is hard to reach in
practice, because the Overview's `Set up a coordinator` opens the wizard directly.

A new test pins the geometry: preferences and Add coordinator are 10 px apart with the primary action
last and flush with the row's right edge, and the description ends before the preferences button.
Both buttons are default-sized rather than compact, matching the primary button they pair with; the
pair is ~577 px wide, and the row's `Expanded` description absorbs the difference down to narrower
windows.

Validation: `flutter analyze` clean apart from one pre-existing info; Flutter 181 pass / 1 skipped /
2 fail (both pre-existing `social_preview_test.dart`). The backend was untouched. Verified live: 2338
installed and healthy, signature verified, production untouched.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/actions-2338/local-2337-rollback.bundle`.

## 2336 — Settings becomes three real tabs (`local-settings-tabs-2336`)

Settings was rebuilt against an owner design reference. The sub-nav is now **real tabs**, not a
scroll anchor: before this, clicking a nav row set `settingsTab` and called
`Scrollable.ensureVisible`, so all three sections always rendered, the highlight never followed
scrolling, and below 700px the nav disappeared entirely. Only the selected section renders now, and
the nav stays reachable at any width (it stacks above the pane under 900px).

- **Nav badges** (owner-chosen): amber dot on This Mac when the bridge is offline, a preference or
  server-mode error is set, or server mode stopped taking effect; green/amber dot on Remote control
  for connected / link-sent; `New` chip on Updates when a release is available. Keyed
  `settings-badge-<id>` so it is testable.
- **Section heading** per tab (icon tile, title, one line), with the status pill moved onto the
  section it describes instead of hanging off a panel title.
- **One card per setting** with a 40px icon tile; copy cut to one line, long caveats moved into the
  card footer, so the FileVault and "does not bypass your password" warnings still exist.
- Remote control leads with a three-step stepper (Permissions / Password / Connect) driven by real
  state, permissions as their own cards, password and phone steps side by side.
- "Remove server mode helper" moved out of the row flow into the lid-closed card footer.
- `settingsTab` holds stable ids (`this-mac` / `remote` / `updates`), not display titles, and
  `settingsKeys` was deleted. The "View settings" button in `screens.dart` selects `remote` directly.

**Deliberately not built:** the reference's "Automatically download and install updates" toggle and
its "Every hour" dropdown. No such preference exists in the backend, and a control that does nothing
is worse than no control. Updates states the real behaviour (checked at open, then hourly; a manual
check is allowed once a minute; installs after current work finishes) and still says "Not checked yet
on this run" before the first check rather than claiming the app is current.

Validation: `flutter analyze` clean apart from the one pre-existing info in
`social_image_settings_test.dart`. Desktop suite **176 pass / 2 fail / 1 skipped**, the 2 being the
known pre-existing `social_preview_test.dart` "0 drafts" failures. Five new tests in
`settings_design_test.dart` (one section at a time and tab switching, no up-to-date claim before a
check, the remote stepper, a badge when attention is needed, no badge when healthy) plus seven stale
assertions updated in `widget_test.dart` and `settings_design_test.dart` for the tab navigation.
Backend `npm run build` and `tsc --noEmit` clean.

Installed as 2336, backend running from the installed path, unauthenticated loopback 401. Not
exercised: a live walk of all three tabs in the installed app.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/settings-tabs-2336/local-2335-rollback.bundle`.

### Concurrent sessions on this snapshot (read before the next build)

Another agent was editing the same snapshot throughout this work; it added `desktop/lib/ffd_select.dart`,
wired it into the coordinator dialog, and installed 2334 then 2335 while 2336 was being prepared.
Observed consequences:

- Test results move under you. `coordinator_setup_page_test.dart` and `coordinator_detection_test.dart`
  failed mid-write and went green minutes later; those failures were theirs, not this change's.
- **Two `flutter build macos` runs share one output directory** (`desktop/build/macos/...`), so builds
  must be serialised across sessions. Do not start one while another is running.
- Take a build number **above the installed one at the moment you build**: 2334 was taken and 2335
  installed while this was being planned, so this landed as 2336.
- No `src/` file was changed by 2336. The backend suite read 1617 pass / 11 fail in both the 2335
  record and this run, and among those 11 are four workspace-discovery cases
  (`Claude workspace creation...`, `project picker groups Git worktrees...`, `workspace discovery
  deduplicates real paths...`, `worktree-like folder names...`) in the area the other session is
  actively editing. They were already in the running 2335 backend, so 2336 does not add them.

## 2337 — Settings matched to the reference, verified against pixels (`local-settings-tabs-2337`)

The owner looked at 2336 and said the Remote control page did not match. It did not: 2336 was built
from a code reading, never from a render. 2337 is the same feature corrected against renders of all
three tabs, compared side by side with the reference.

Method, worth reusing for any Settings or dialog redesign: a temporary widget test rendered each tab
at 1536x1024 through `matchesGoldenFile` with `--update-goldens`, the PNGs were read back and compared
with the reference, and the harness was then deleted (the repo keeps no goldens; a golden here would
break on every unrelated UI change). The four renders are archived at
`/Volumes/Personal/Developer/FarFromDesk/Builds/settings-tabs-2337-renders/`. Two details make it
work: load the real fonts first (`Onest` + `MaterialIcons`) or text renders as blocks, and override
`Gateway.checkUpdates` to render the "up to date" state, which is otherwise unreachable in a test.

What the render exposed and 2337 fixes:

- **Dead right margin.** The pane capped the body at 820 px and the nav at 248 px, leaving about
  265 px empty at 1536. Now the nav column is 323 px (matching the reference's 250 px sidebar plus
  padding) and the body fills to the right edge, capped at 980.
- **Card footer misalignment.** The footer was inset 60 px while the title starts at card padding
  plus tile plus gap (84 px), so caveats and pills did not line up under the title they belong to.
- **Remote control hero.** The stepper sat below the heading; the reference puts the three steps on
  the same row, to the right of it, with step 1 filled in the accent colour. Now it does, and it
  falls back to a stacked layout below 720 px so the row can never overflow (it did by 1.5 px at the
  test's 1280 px viewport, which broke two tests).
- **Remote control columns.** Password and phone steps were two bordered cards; the reference uses
  two unframed columns split by a hairline rule. Now unframed, with the visibility (eye) toggles the
  reference shows on both password fields.
- **Status pills.** Permission, password and state pills now use `tag()` (dot plus wash) like the
  reference instead of the dotless chip.
- **Copy.** This Mac subtitle is "Control how FarFromDesk runs on this Mac and stays available", the
  Updates subtitle names features and fixes, the keep-awake card folds its caveat into the row's own
  line, the lid-closed state is one ⓘ note ("Lid-closed sleep is off on power. Keep the vents clear
  for proper airflow."), and the Updates tick is a solid green disc with a white check.

Still deliberately different from the reference, and why: no "Automatically download and install
updates" toggle and no "Every hour" dropdown (no such backend preference exists, so both would be
controls that do nothing — the tab states the real behaviour instead), and the permission rows keep a
refresh button beside the reference's single external-link button, because macOS permissions change
outside the app and the owner should not have to wait for the timer.

Validation: `flutter analyze` clean apart from the one pre-existing info; desktop **175 pass / 3 fail
/ 1 skipped**, the 3 being the two known `social_preview_test.dart` failures plus
`widget_test.dart: Coordinator app preferences save Desktop...`, which fails on
`type 'FfdSelect<String>' is not a subtype of type 'DropdownButton<String>'` — the other session's
in-flight picker refactor, not this change. Installed as 2337, backend running from the installed
path, loopback 401, production untouched.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/settings-tabs-2337/local-2336-rollback.bundle`.

## 2338 — Settings two-column fix and a hidden Permissions bug (`local-settings-tabs-2338`)

The owner sent a screenshot of 2337 running and the page did not match the reference: the nav was
stacked full-width above the cards instead of sitting in a left column. Cause: the two-column
breakpoint was 1020 logical px, and the owner's window is about 1156x814 logical (DPR 2), so the pane
got ~954 px and fell into the stacked fallback. **A `LayoutBuilder` breakpoint is a bet about window
size, and this one was wrong for the owner's actual window.** It is now 820, which is the width the
nav (323 px) plus a usable card column can still live in, and the two-column layout was rendered at
1156x814 to confirm.

Rendering the page with real glyphs then exposed a second, worse fault that no test had caught:
`checkMac()` in `app.dart` did `status['macControl'] = next`, **replacing** the map with the
`/api/mac-control` POST response. `remoteControlPanels()` gates the whole Permissions section on
`status['macControl']['supported']`, so any check response that omitted `supported` blanked the flag
and the Permissions heading, Accessibility and Screen Recording vanished from the page until the
next status poll restored them. It now merges the response over the previous map, including the
nested `capture` object, so a partial response cannot delete what it did not mention.

Also matched to the reference: both permission pills are now amber `Not allowed` (Screen Recording
was muted, which read as "not required" while the section caption says both are required).

### Rendering the app instead of reading it

The way to verify a UI claim in this repo without a screen-recording grant:

- `screencapture` does **not** work from the agent process: `could not create image from display`,
  because the harness app has no Screen Recording permission. Any real screen capture needs the owner
  to grant it in System Settings → Privacy & Security → Screen Recording for the app running the
  agent.
- A temporary widget test with `matchesGoldenFile` and `--update-goldens` renders the real widget tree
  to a PNG at an exact window size. Two things make the output readable: load a real font first (the
  app draws in the macOS system font; Onest is declared in `pubspec.yaml` but never referenced, so
  without this every glyph is a filled box), and register the same bytes under each candidate default
  family (`Roboto`, `.AppleSystemUIFont`, `.SF Pro Text`, `.SF UI Text`, `San Francisco`).
  `/System/Library/Fonts/SFNS.ttf` and `SFNSMono.ttf` (as `Menlo`) are enough.
- **Button labels still render as blocks** under this harness while ordinary `Text` renders correctly.
  Do not read that as a product bug: it is a flutter_test font-resolution limit for `ButtonStyle`
  text, and buttons render normally in the shipped app (the owner's own screenshot shows "Refresh
  connection" correctly).
- Override `Gateway.checkUpdates` to reach the "up to date" state, which no test fixture produces;
  and override `post` for `/api/mac-control`, since the Permissions section is driven by that call.
- Delete the harness afterwards. This repo keeps no goldens and a golden would break on every
  unrelated UI change, especially with another session editing the same tree.

Renders for both window sizes are archived at
`/Volumes/Personal/Developer/FarFromDesk/Builds/settings-tabs-2337-renders/`
(`settings-*` at 1536x1024, `win-*` at the owner's 1156x814).

Validation: `flutter analyze` clean apart from the one pre-existing info; desktop **178 pass / 2 fail /
1 skipped**, the 2 being the known `social_preview_test.dart` failures only (the other session's
`FfdSelect` failure cleared on its own). Installed as 2338, backend running from the installed path,
loopback 401, production untouched.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/settings-tabs-2338/local-2336-rollback.bundle`.
Note the installed bundle read 2336 again just before this build: the other session replaced it, so
take the build number from the installed bundle before building, not from this file.

## 2339 — Settings colour, sticky nav, and an install-script trap (`local-settings-tabs-2339`)

Three owner corrections, all measured against the reference rather than judged by eye.

**Too much orange.** Sampling the reference with PIL proved it: the design uses a **warm tile only on
the section heading** (`#311c11` with a `#ff6f29` icon) and **neutral tiles on every row**
(`#1d1d1b` with a **white** icon). The implementation painted every row tile with `accentWash` plus
an accent border, which is what made a page of settings read as a wall of orange. `settingsIconTile`
now takes `accentTile:` — true only for the section heading — and the tiles have no border. Verified
after the change: heading tile `#2f180e` against the reference's `#311c11`, row tiles `#1d1d1d`
against `#1d1d1b`.

A second claim I checked and did **not** change: the active nav row. A median sample suggested mine
was too dark, but a scan across the row showed the real fill is `#2e1a0f` in the reference against my
`#2e1d16` — already matching. The first sample had picked up the orange border and lighter text.
Sample a scan, not a median box, before "fixing" a colour.

**Sticky nav.** The nav was inside the pane's single scroll view, so it scrolled away, and it is the
only way to reach a section. The pane is now a `Row` of two independent scroll views: a fixed 258 px
nav column and the scrolling pane. Width went 323 → 258 (80%) at the owner's request. New test
`the settings nav stays put while the pane scrolls` drags the pane and asserts the nav's origin is
unchanged **and** that the pane really moved, so it cannot pass on untouchable content.

### Install trap: an orphaned backend crash-loops the next launch

After installing 2339 the Local backend accepted TCP connections but never answered; `/health` hung
while production (47831) answered normally, and the process sat at 0% CPU. `logs/error.log` showed
2,058 accumulated `FarFromDesk is already running for this data directory` crashes: an **orphaned
backend (ppid 1) survived SIGTERM**, kept the sqlite service lock and the port, and every backend the
relaunched app spawned died on the lock in a loop.

Recovery: quit the app, then SIGTERM and, if it survives, **SIGKILL** only the process whose command
line starts with the installed `FarFromDesk Local.app/` path (verify with `ps -p PID -o command=`),
confirm `lsof -nP -iTCP:47961` is empty, and relaunch. Health returned 401 within 4 seconds.

`install-2339.sh` now escalates to SIGKILL for this bundle's backend processes, refuses to proceed
while anything still holds port 47961, and never kills a process outside this bundle. Any later
install script should be copied from it, not from 2337/2338.

Also worth knowing: `Bridge could not start: listen EADDRINUSE 127.0.0.1:47831` appears 116 times
through the log's history. It is a Local helper reaching for the *production* port and is
pre-existing noise, not a build fault. Do not chase it.

Validation: `flutter analyze` clean apart from the one pre-existing info; desktop **180 pass / 2 fail /
1 skipped**, the 2 being the known `social_preview_test.dart` failures. Installed as 2339, backend
running from the installed path, loopback 401, production untouched.

Rollback: `/Volumes/Personal/Developer/FarFromDesk/Builds/settings-tabs-2339/local-2337-rollback.bundle`.
Renders for both window sizes: `/Volumes/Personal/Developer/FarFromDesk/Builds/settings-tabs-2338-renders/`.

### The Local backend wedges on every build right now (not a 2339 fault)

While verifying 2339 the Local backend **hung**: `/health` timed out, `server-mode.json` sat at 0% CPU,
a TCP connection was accepted but never answered, the 20s heartbeat froze and the WAL stopped growing.
`logs/error.log` also carries 2,058 accumulated `FarFromDesk is already running for this data
directory` crashes from the churn around repeated installs.

This is **not** caused by 2339 and not by the Settings work, which is UI-only and touches no backend
file. Proven by installing the previous build and watching it the same way:

| Build | backend buildId | answers `/health` at start | after 90s |
|---|---|---|---|
| 2339 | `local-settings-tabs-2339` | 401 | health 000, heartbeat frozen |
| 2337 | `local-muse-logo-2337` | 401 | health 000, heartbeat frozen |

Both wedge identically, so the trigger is environmental or in the backend rather than in this change.
The earlier "health 401" verifications recorded for 2336-2338 were all taken **immediately** after
install, which is exactly when the backend still answers. **Check a Local build at least 90 seconds
after launch before claiming it is healthy**; a single immediate 401 proves only that it bound the
port.

Recovery that works: quit the app, SIGKILL only processes whose command line starts with the installed
`FarFromDesk Local.app/` path, confirm `lsof -nP -iTCP:47961` is empty, relaunch. The wedge returns.

Not yet established: the root cause. The next step is to run the installed backend under `node
--trace-uncaught` / attach an inspector and see where the event loop stops, and to check whether the
`ffd-accessibility --server` helper (which macOS reports as not allowed) is what the backend blocks
on. Whoever picks this up should not assume it is a UI problem.

Left installed: **2339**, so the Settings redesign is in place; both builds degrade the same way.

### Screen capture now works; clicking does not (2 Nov, ~04:20)

The owner granted Screen Recording to the agent app, so `screencapture` works and real screenshots of
the running app can be taken: `screencapture -x /tmp/x.png` gives the full display (2940x1912 at DPR 2
on this Mac), and the app window is cropped from it. A clean capture of This Mac on 2339 is archived at
`/Volumes/Personal/Developer/FarFromDesk/Builds/settings-tabs-2339-renders/app-2339-this-mac.png`.

Measured on the **real app**, against the design: heading tile `#2c1910` vs `#311c11`, row icon tile
`#1d1d1d` vs `#1d1d1b`, card body `#0f0f0f` vs `#111111`. Nav column 17.7% of window width against the
design's 16.9%; content 57.3% against 60.2%. So the colour and proportion corrections hold on the
shipped build, not only in the test render.

**Clicking is still refused**: `osascript -e 'tell application "System Events" to click at {x,y}'`
returns `osascript is not allowed assistive access (-25211)`, and macOS then raises a
"DeepSeek Harness would like to control this Mac" consent dialog. Driving the UI needs the owner to
grant **Accessibility** to the agent app as well; Screen Recording alone is not enough. Until then,
capture only the tab that is already open and use the golden render harness for the others, or ask the
owner to click through while capturing.

## Companion handover: block cards, takeover guide, hook repair (2 November 2026)

The owner asked for the bridge to behave like a companion: when a session blocks on a permission,
say so at once, offer allow or deny, and when the remote answer cannot finish the job, hand the Mac
back with exact steps. Backend only; source is the shared snapshot above.

Evidence read from both apps' own databases before changing anything:

- Production has 6 permission messages ever. On 29 Oct a Claude Desktop `AskUserQuestion` (4
  questions, 2 multi-select) was sent as `Permission needed ... Reply Yes, allow it or No, deny it`,
  which cannot answer it. The owner allows, the session still shows its own dialog, nothing says so.
- No code checked whether an allow actually unblocked a session.
- `~/.claude/settings.json` had no FarFromDesk hook (only Superset and Budge), so Claude prompts never
  reached the bridge at all. The Codex hook pointed at the parent checkout's `dist` with the default
  state and port, so a Local session's prompt posted where that session is not registered.
- The proactive watch ran only on the paired WhatsApp self-chat and only with the Meta brain on.
  `stuck_alerts` was empty in Local and absent in production.

What changed:

- `src/provider-hooks.ts` (new): installs or repairs exactly one namespaced hook per provider, pinned
  to this build's `WSB_STATE_DIR` and `WSB_PORT`, keeps every other tool's groups, writes only when
  the file really changed, backs it up first, and refuses to touch unparseable JSON. Called at startup
  from `main.ts` and reused by `cli.ts install-hooks`.
- `src/companion.ts` (new): the block card, the question card, the takeover guide, and the handover and
  decision records that let a later check use real state.
- `src/approvals.ts`: a session prompt now sends a card (plain words for what the tool does, the exact
  request, `1 Allow it`, `2 Deny it`, `3 I do it on the Mac myself`). A number counts only when it
  quotes the card it answers. Option 3 resolves as `native` and sends the guide. Every decision is
  recorded, so a stall can be seen.
- `src/hooks.ts`, `src/server.ts`: a `native` decision prints no hook decision, which returns the
  prompt to the app's own dialog. `AskUserQuestion` is never offered as a yes or no: the real questions
  and options are sent and the prompt goes back to the app.
- `src/stuck-detection.ts`: the watch follows the owner's live channel, Telegram included; the approval
  notice uses the same 1-allow, 2-deny, 3-take-over order; a new `stalled` signal sends the takeover
  guide when an allow produced no move after three minutes; `/done` checks the session and never
  resends work.
- `src/router.ts`, `src/store.ts`: owner provenance is recorded and resolved for the live channel
  instead of only `wa:` ids. This is what the watch and the item list are built on for Telegram; the
  other origin consumers (guided jobs, morning brief, proof scope) already gate on the channel
  themselves. A WhatsApp id keeps resolving when Telegram is selected, which one existing
  morning-brief test checks.

Validation: `tsc --noEmit` clean, `npm run build` clean. Full suite **1653 pass / 12 fail**, all in the
known baseline families (coordinator role wording, staged handoff, workspace discovery, approval
provenance). The two `/api/status` failures are the concurrently editing session's in-flight
`desktopControl.permissionReport` change: its test stubs do not provide that method yet, which the
failure message states verbatim. New `test/companion-handover.test.ts` (8 tests) covers the card, the
numbered take-over with a checkable handover, the question handover, the stall guide, the Telegram
watch and the hook installer (idempotency, repair of an older command, backups, unreadable files left
alone). `test/stuck-detection.test.ts` was updated to the 1-allow order and passes 68.

One real bug the new tests caught: `installProviderHooks` threw ENOENT on a machine with no provider
config directory yet; it now creates it.

Not done: nothing was packaged or installed, so Local remained at the other session's build. Not
exercised: a live permission prompt through the repaired hook, and a real WhatsApp or Telegram block.
Next: package the backend over the installed Local app with a build number above the installed one,
then trigger one real Claude permission prompt and one real Telegram block.

### Installed: companion handover, Local 2352-2353

Build 2352 (`local-companion-hook-guard-2352`) then 2353 (`local-companion-handover-2353`) installed the
companion work over 2347. Backend-only packaging: the previous stage was cloned on the same volume, the
fresh `dist/` and `skills/` overlaid, and the diff against the installed backend was exactly the files
this change touches (2352: `provider-hooks.js`; 2353: `companion.js`).

Three real faults were found only by installing and looking, and each is fixed:

1. **The hooks went to the wrong home.** The isolated Local backend runs with a private `HOME`
   (`<state>/home`) and sets `CLAUDE_CONFIG_DIR` to its own private profile, while Claude Desktop and
   the Codex app read the owner's real profiles. The first install therefore wrote hooks that no
   provider would ever load, and `provider-hooks-status` reported them as installed. `ownerHome()` now
   detects a private home from the state relationship (the isolated flag is not always exported) and
   `providerConfigDir()` ignores a `CLAUDE_CONFIG_DIR`/`CODEX_HOME` that points inside our own state.
2. **A packaged smoke could write into the owner's real profile.** The smoke sets `FFD_ISOLATED_LOCAL`
   plus a temp state, which is exactly the shape that resolves to the real home, so it added a hook
   pointing at its own dead temp state to `~/.claude/settings.json`. Proven by diffing the file before
   and after a smoke, then repaired byte-perfect from the automatic backup (hash matched the 03:33
   original). `installProviderHooks` now refuses a test context or a scratch state directory and says so.
3. **A stopped bridge used to deny permissions.** `hooks.ts` started from `answer='deny'`, so an
   unreachable, stopped or paused bridge silently denied the owner's prompt. Only an explicit answer
   from the bridge now produces a decision; anything else defers and the app's own prompt takes over.
   This also removed the double-ask: previously a prompt arriving before the dispatch window could be
   asked twice.

Verified live on 2353: `~/.claude/settings.json` carries exactly one bridge hook per event pinned to
`WSB_STATE_DIR='.../FarFromDesk Local'` and `WSB_PORT=47961` with the installed app's own node and
`dist/cli.js`, and the other 8 hooks (Superset, Budge, graft) are untouched. `~/.codex/hooks.json` is
byte-identical to before the install: a Codex hook owned by the production install is reported
`owned-by-other` and never replaced, so the owner's production permission approvals keep working.
A live `AskUserQuestion` through the installed hook returned `{"answer":"native"}` (no hook decision,
prompt handed back to the app) and its card was delivered to the owner's Telegram at 15:37:56.

Known local condition, unchanged by this build: the installed Local backend stops answering `/health`
about a minute after launch (health 401 at first, then 000, process alive at 0% CPU). 2349, 2350, 2352
and 2353 all show it, as 2337 and 2339 did. While it is wedged the hook defers rather than denying.

Not verified: a real Claude Code or Codex permission prompt raised by the provider app itself, and a
real owner reply of 1/2/3 to a card. Next: trigger a genuine prompt from Claude Desktop with the Local
app in its working window, and confirm the three-option card and the takeover guide on the phone.

## 2354 — startup recovers by itself (`local-startup-recovery-2354`)

The owner reported the Overview showing "The local backend did not start. Check that port 47961 is free and
the installation is complete." while switching tabs and back showed a perfect app. It was a state bug, not a
dead backend.

Cause: `boot()` in `desktop/lib/app.dart` armed the 3 second status poll **only after** a successful start.
One slow or refused start (the gateway waits 15s for backend health, and a busy launch, a service-lock race or
a still-settling backend all look the same) threw, set `error`, and left `ready == false` with no timer to
clear it. Nothing retried, so only a manual "Try again" or some later rebuild recovered it.

Fix, all in `app.dart` plus one typed failure in `native_gateway.dart`:

- `BackendNotReady` marks the health-wait failure as retryable. Every other failure is still reported at once,
  so the window-manager error tests keep their behaviour.
- A retryable start keeps the spinner instead of claiming failure, retries itself every 3s (bounded at 40
  attempts), and arms the status poll immediately. A poll that lands while a retry is running stays quiet.
- A status that arrives without a completed startup finishes it: `ready`, items loaded, readiness reported. So
  the app heals through the poll alone.
- Once the app is running, one failed poll no longer replaces a working screen with a startup error.
- `boot()` no longer overlaps itself; the new `bootRetryTimer` is cancelled in `dispose`.

Validation: `flutter analyze` clean apart from the one pre-existing info. Desktop suite **213 pass / 2 fail**
(the known `social_preview_test.dart` pair). Two new tests in `desktop/test/desktop_startup_test.dart`
("a slow launch recovers by itself instead of leaving a backend banner", "a backend that stays down is
reported, then clears itself when it answers"), with the two existing window-failure tests still green.

Reproduced live on the installed build: a refusing listener held 47961 while the app launched. It showed
"Starting FarFromDesk…" with a spinner and no false banner; the listener was then killed and, with no click and
no tab switch, the app recovered by itself into the full Overview while `/health` came back 401. Screenshots in
`/tmp/outage2-s.png` and `/tmp/recovered-s.png` at the time of the test.

Concurrent-session note: another session had installed their `channel-mark-2348` over 2353, so this install
found 2348 as the previous version and left `startup-recovery-2354/local-2348-rollback.bundle`. 2354 was built
from the shared source as of 16:05, which includes their `studio_panes.dart` work (15:43), so nothing of theirs
was dropped by the replacement. Build numbers are now racing between sessions: take the installed version at
build time, as this file already warns.

## 2356 — Remote control is one permissions list, and two password states (`local-settings-remote-2356`)

Owner review of Settings → Remote control: "make this page simpler ... we don't need
already if permission is there means it can control ... remove the sessions allowed
to control this Mac section ... redesign the remote password section both not set
and set state". Three decisions were taken with the owner before any code moved:
remove the per-session allowlist *and* its backend gate; fold the driver's grants
into the Permissions list; and give the password one card with two states.

- **One permissions list.** The page said the same thing three times: Permissions
  (the helper's Accessibility and Screen Recording), Desktop control (the driver's
  own two grants under their own heading) and Sessions allowed. The driver's rows
  now sit in the Permissions list, named as the driver's (`mac_control_panel.dart`
  reads `status['desktopControl']['permission']`), with the note that macOS tracks
  them against the driver rather than the helper. The "Desktop control" heading and
  `desktop_control_panel.dart` are gone. Only the helper's rows carry the
  "open System Settings" button (that pane is the helper's); the driver's rows carry
  refresh only, and the 15-second status probe keeps them fresh.
- **The per-session allowlist is gone, both sides, on purpose.** `src/server.ts` no
  longer defines or reads `desktop-control-sessions`, its GET and POST endpoints are
  removed, `/api/status` no longer publishes `desktopControlSessions`, and the
  `DESKTOP_CONTROL_NOT_ALLOWED` refusal is deleted. A registered session may now
  drive the Mac on a request it was actually given; `requireDesktopPermission()`
  (the driver's own macOS grant) is the only remaining gate, exactly as for the
  master route. The stored `desktop-control-sessions` key is left in place and
  ignored. **Do not re-add the allowlist as a "missing safety control" — the owner
  removed it deliberately, because the macOS grant is the real gate.**
- **Remote password, one card, two states.** Not set: the form is the whole column
  with one primary "Set password". Set: a locked mask row ("Stored on this Mac"),
  the note that changing it ends any open phone session, and one "Change password"
  action that swaps the same form back in with "Save new password" and Cancel. The
  fields are never shown over a working password. The mask is a fixed twelve dots
  because the backend keeps a salt and a scrypt hash and not the length. The row is a
  `Wrap`, not a `Row`: the column is about 277 px at the owner's window and the label
  carries the computer's name, which overflowed a `Row` by 11 px.

Validation: `flutter analyze` clean apart from the one pre-existing info in
`social_image_settings_test.dart`; desktop suite **231 pass / 1 skipped / 2 fail**,
the two being the known pre-existing `social_preview_test.dart` failures; `tsc` and
`npm run build` clean; backend suite **1667 pass / 14 fail**, and the *same 14* fail
with `src/server.ts` reverted, so this change adds none. Two of those 14 are the
`/api/status` stubs that omit `desktopControl.permissionReport`, which is why
`test/http-hooks.test.ts` and `test/inbox-session-label-http.test.ts` fail there;
that is another session's in-flight area, not this change. Two new widget tests in
`widget_test.dart` pin the folded list (`MacControlGateway` gained
`driverAccessibility` / `driverScreenRecording`) and the two password states.

Verified: the redesigned tab was rendered at the owner's 1156x814 window through a
temporary golden harness, which was then deleted (the repo keeps no goldens); the
renders are archived beside this build. Installed as 2356; the UI and backend
processes run from the installed path and loopback `/health` returned 401
immediately after launch and again six minutes later. The shipped Dart AOT snapshot
carries "Desktop driver access", "Desktop driver screen access", "Change password",
"Set password", "Save new password" and "Stored on this ", and carries none of
"Sessions allowed to control this Mac", "What FarFromDesk needs to drive another
app" or "No connected session to choose from yet."; the shipped `dist/server.js`
contains no `desktop-control-sessions`, `desktopControlSessions` or
`DESKTOP_CONTROL_NOT_ALLOWED`.

Not verified: a live walk of the Settings tab in the installed app (the agent cannot
click — it holds Screen Recording but not Accessibility), and a real desktop-control
run from a coding session under the new policy. Both need the owner.

Rollback: `settings-remote-2356/local-2355-rollback.bundle`. Source `/private/tmp/ffd-pr`
at `0be1765`; the commit before it (`293c766`, the `/muse` command gate) is another
session's, and the checkout is shared, so re-check `git log` before building the next one.

**Superseded within the hour by 2357** (`local-delivery-choice-2357`, another
session's close-app delivery-choice build), which was built on top of this commit.
Verified in the installed 2357 bundle: the Dart AOT still carries "Desktop driver
screen access", "Change password" and "Save new password", still contains none of
"Sessions allowed to control this Mac" or "No connected session to choose from
yet.", and its `dist/server.js` has no `desktop-control-sessions` or
`DESKTOP_CONTROL_NOT_ALLOWED` while keeping the `/api/session/desktop-control`
route. So the change is live in the app on disk now, not only in 2356.

## Tooling: one `ffd` command for Local work (3 November 2026)

The 2356 change cost about 100 minutes of wall clock, of which roughly 7 minutes was
real compute. The rest was stale context (this file's own header still pointed at the
31 October snapshot and version 2323), two hand-written stage and install scripts, a
second full test-suite run purely to attribute the failures, a render harness
rewritten from scratch, and seven sandbox approval prompts because Flutter's SDK
lives outside the session workspace. That work is now one command:

- `ffd status` — installed version and buildId, which checkout the source is and its
  HEAD, uncommitted files (another session's work), whether a build is in flight,
  what is running, the health code, and the next build number.
- `ffd test backend [--baseline]` and `ffd test desktop [--all|files]` — run and diff
  against `baseline/`, which holds the failures that were already there. They are
  flaky, not deterministic: on 3 November 13 of the 14 backend entries and both
  desktop entries passed on a later run, so a baseline entry that passes is reported,
  never treated as an error.
- `ffd render <scenario>` — copies `templates/render_scenarios.dart` in, renders one
  screen at the owner's 1156x814, copies the PNG out, and deletes the harness and its
  goldens even on failure. Verified byte-identical to the hand-written harness used
  for 2356.
- `ffd ship [--build N] [--note NAME]` — backend build, flutter release build, stage,
  sign, packaged smoke, install, report. It derives the build number from the
  installed bundle and refuses to build while another `flutter build` is running.
- `ffd rollback [bundle]`.
- On PATH as `~/.local/bin/ffd`; paths are in `scripts/ffd.conf`. The traps it
  encodes (SDK `dart format` rewrites this repo, Flutter's cache is outside the
  workspace, assets render blank in a single-scenario golden, the old install script's
  `set -e` + `pipefail` swallowed its own report) are in [tooling.md](tooling.md).

`ffd status` caught the other session installing 2357 over 2356 while this was being
written, which is what it is for. Run it before building: the installed bundle is the
only reliable base for the next build number.

## Why a rebuild loses the Accessibility and Screen Recording grants (3 November 2026)

The owner's report: rebuilding the app loses its remote control permission. Cause,
established from tccd's own log rather than from theory:

```
AUTHREQ_ATTRIBUTION: attribution={responsible={identifier=com.codecylabs.farfromdesk.localtest ...},
                                   accessing={identifier=...localtest.accessibility ...ffd-accessibility}}
AUTHREQ_SUBJECT: subject=com.codecylabs.farfromdesk.localtest
-[TCCDAccessIdentity staticCode]: static code for: identifier com.codecylabs.farfromdesk.localtest ... at /Users/sagar/Applications/FarFromDesk Local.app
```

**The subject is the app bundle, not the helper it launches.** Both are ad-hoc signed,
and an ad-hoc signature's designated requirement is a bare `cdhash H"..."` (`codesign
-d -r-` prints exactly that), so the grant belongs to the app's exact bytes. The app's
cdhash changes on every build (measured: `ba783e59` at 2355, `d6a7beec` at 2356,
`ca5ae019` at 2357), which is why each rebuild comes back with Accessibility and
Screen Recording off and phone control cannot start.

Corrections to earlier notes in this file: the helper binaries are **not** the cause.
`ffd ship` already carries them forward unchanged (their cdhashes were identical
across 2355-2357), and that did not save the grant. A process tree that already holds
the grants also answers for itself, so running one helper tells you nothing about what
the app will see.

Two things this implies beyond Local:

- **Production is affected too.** `/Users/sagar/Applications/FarFromDesk.app` is ad-hoc
  signed (`app.sessionbridge.mac`, `TeamIdentifier=not set`, requirement
  `cdhash H"4c0a8f70..."`), so every released update asks every user to re-approve
  Accessibility and Screen Recording. This is a release-level problem, not a Local
  annoyance.
- **`cua-driver` is the counter-example that proves the fix.** It keeps the vendor's
  signature (Team ID `YCK386LBJ7`), so its requirement names the team rather than the
  bytes and its grant survives every rebuild.

Fix: sign with an identity. `security find-identity -v -p codesigning` reported **0
valid identities** on this Mac; Xcode 27.1 is installed, so a free Apple ID plus
Xcode > Settings > Accounts > Manage Certificates > Apple Development produces one.
Then the requirement is `identifier + anchor apple generic + certificate
leaf[subject.OU] = TEAMID`, and the owner allows the two services once.

Applied so far (helper side only, and it does not fix the app's grant): 
`script/build_accessibility_helper.py` now caches each helper under
`build/native-helper-cache/` on a key of the Swift source bytes, the swiftc and SDK
versions and the exact compile arguments, reuses an unchanged helper instead of
recompiling it, takes `--no-cache` for a clean release build, and gives `session-state`
an explicit `--identifier com.codecylabs.farfromdesk.localtest.session-state` instead
of a linker-derived UUID. Verified: cache hit reproduces byte-identical output, a
source change rebuilds only the affected helper, `--no-cache` rebuilds both, both
helpers still pass `codesign --verify --strict`, and `session-state --self-test`
passes. One-time cost of the identifier change: the next packaging run re-signs
`session-state`, so its grant needs one re-approval.

Until a certificate exists: `ffd permissions` names the changed binary and prints the
exact `tccutil reset` for it, and `ffd ship` records the same in the stage's
`RESULTS.md`. `tccutil` cannot grant; only the owner can switch the row on.

### Signing identity installed, and the missing intermediate (3 November 2026)

The owner created an Apple Development certificate, so the fix for the lost grants is
in place. Details a future session will need:

- Identity: **`Apple Development: sagar.kumar.iitbombay@gmail.com (P4X9842Y28)`**,
  **Team ID `75H3D9G65L`**, valid to 3 November 2027. `security find-identity -v -p
  codesigning` now reports 1 valid identity.
- It did **not** work at first. `codesign` failed with `unable to build chain to
  self-signed root ... errSecInternalComponent` while Xcode listed the certificate
  normally. Cause: the certificate is issued by **WWDR G3**, and the only intermediate
  installed was the 2013 WWDR CA, which expired on 7 February 2023. Fix: install
  Apple's G3 intermediate from its own certificate authority page
  (`https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer`) into the login
  keychain with `security add-certificates`, which adds the certificate and changes no
  trust settings. **The release machine will need the same intermediate.**
- Installed as **2360** (`local-signed-grants-2360`). The app's designated requirement
  is now team-anchored instead of a cdhash:
  `identifier "com.codecylabs.farfromdesk.localtest" and anchor apple generic and
  certificate leaf[subject.CN] = "Apple Development: ..."`, with chain Apple
  Development > Apple Worldwide Developer Relations Certification Authority > Apple
  Root CA. `ffd permissions` reports all three Local subjects as identity
  `75H3D9G65L` and the driver as `YCK386LBJ7`, so no cdhash-based grant is left.
- One re-approval is still expected after this first signed build, because to macOS it
  is a different app from the ad-hoc ones. After that, rebuilds should keep the grants;
  that is the thing to confirm with a second signed install.
- Not done: nothing signs with the identity on the release path yet, and production
  (`app.sessionbridge.mac`) is still ad-hoc, so its users still re-approve after every
  release. That needs a Developer ID certificate (paid program).

### The Local start guard must not trust HOME (3 November 2026)

After granting the permissions the owner restarted the app and got **"Local state
overlaps protected data: /Users/sagar/Library/Application Support/FarFromDesk Local"**
with no way forward. The app had been started with `HOME` set to the *backend's*
isolated home (`<state>/home`), so `assertLocalStateSafe` built its "protected" list
from that home and five of those roots landed inside the Local state, which the guard
reads as an overlap and refuses. Verified by reproducing the comparison: with
`HOME=/Users/sagar` nothing overlaps and Local starts; with the isolated home it is
refused.

`resolveOwnerHome()` in `local_state_guard.dart` now resolves the account home from
three candidates in order: the build-time `FFD_OWNER_HOME` define, `/Users/$USER`,
then `$HOME`, skipping anything inside the Local state, and refusing with an
actionable message (naming the define) when none works. `ffd ship` passes
`FFD_OWNER_HOME=$HOME`. Five tests in `local_state_guard_test.dart` cover it.

## 2362 — the driver's rows are capabilities, not grants (`local-driver-permission-model-2362`)

Settings showed "Desktop driver access" and "Desktop driver screen access" as two more
permissions to give. They are not permissions, and there is no way to give them. Three
measurements settled it:

- `cua-driver permissions grant`, the vendor's documented path, hard-codes
  `/Applications/CuaDriver.app` and fails here: "Didn't detect the CuaDriver daemon:
  launching `/Applications/CuaDriver.app` exited Some(1)". That bundle is the vendor's
  installer, not something this package ships.
- Asked through our embedded daemon (`cua-driver call check_permissions '{"prompt":false}'
  --socket /tmp/ffd-cua-*/driver.sock`), the driver explains itself: `attribution: "host"`,
  `embedded: true`, `host_bundle_id: com.codecylabs.farfromdesk.localtest.accessibility`,
  and "No separate driver grant exists or is needed ... the driver never raises its own
  prompt."
- Its `accessibility` boolean cannot be trusted: with every grant in place it reported
  `false` while `get_window_state` through the same driver returned a window's
  accessibility tree (`element_count: 13`).

What changed: `capabilityProbe()` in `src/desktop-control.ts` makes one harmless read
(`list_windows`) through the driver, cached 15 s and forced by the row's Test button;
`/api/status` refreshes it while the preflight disagrees, and
`POST /api/desktop-control-permission {action:'check'|'probe'}` serves the pane. The two
rows are now "Drive another app" (decided by that read) and "See any window" (that read
plus Screen Recording), carry the driver's own reason when it fails, and offer the pane
that really decides them, the app's own Accessibility. `requireDesktopPermission()` asks
the preflight first and refuses only when a live read also fails, so desktop control is
no longer blocked on a machine where everything is granted.

**Correction to the earlier 2356 section and to my first explanation:** the driver rows
were never a second pair of TCC grants. macOS records them against FarFromDesk itself.

macOS 27 also raises a **"Device Control and Data Access"** prompt that names
FarFromDesk Local (not the driver, not the helper). It has to be answered or the grant
never settles.

Verified: desktop suite 237 pass / 1 skipped / 2 fail (the known social_preview pair);
`desktop-control.test.ts` 14 pass including two new cases for the probe, its cache and a
forced re-test; `tsc` clean (it caught a `permissionReport()` nullability the test runner
did not); installed 2362, signed with the Apple Development identity, health 401 at 95 s,
and the live driver read returns 18 windows, so the row reads Allowed in the installed
app. Renders of both states are beside the build. One backend suite failure appeared while
the desktop suite ran in parallel and passed alone: a 5 ms timer test, now warned about by
`ffd test backend`.

## 2377 — the lid stays shut and the Mac stays reachable (`local-local-lid-grace-2377`)

Installed 3 November 2026, signed with the Apple Development identity. The owner asked
whether the laptop can really act as a server: lid closed, every screen usable, no cloud.

**What was already there.** The whole privileged half existed from 2325: the root
LaunchDaemon `com.codecylabs.farfromdesk.servermode`, `native/server-mode/helper.sh`, the
`serverMode` preference and its Settings switch. On this machine it was installed, loaded
and holding `SleepDisabled 1`.

**Two things the record got wrong, and one it never had.**

1. The lid-closed case had never been exercised. Cross-referencing
   `/var/log/farfromdesk-servermode.log` with `pmset -g log`: the only lid event since
   server mode existed was `2026-11-01 16:20:02 Clamshell Sleep`, and the helper log shows
   server mode was **off** at that moment (restored 10:35:57Z, re-enabled 10:52:30Z, sleep
   at 10:50:02Z). Every later sleep was `Low Power Sleep` on battery, which is the on-power
   rule working. So no lid-close on AC with server mode active had ever happened.
2. Two documents disagreed about the lock screen: the 0.9.1 release note claims you can
   unlock the Mac from your phone, while `owner-view-native-validation.md` and
   `owner-view-hackathon.md` say lock transitions were never tested and that a locked
   screen is refused. The refusal is the older owner-view path; the claim belongs to
   `src/remote-p2p`. Neither had evidence. Now it does:
   `docs/remote-control-lock-screen.md`.
3. The helper's decision rules could never change on a machine that already had one.
   `setEnabled(true)` installed only when the file was missing, so every existing install
   kept its old rules forever.

**Changed.** The heartbeat rule gained a second threshold as the owner chose: fresh under
`FFD_HEARTBEAT_MAX_AGE` (300s) is a running app, between that and `FFD_GRACE_MAX_AGE`
(7200s) the app is away and the Mac stays awake anyway, and past the window or on battery
normal sleep returns. The helper logs entering the window because the app being absent is
what starts it. A clean shutdown deliberately does **not** release the hold: the backend is
a KeepAlive LaunchAgent, so a restart is routine, and releasing on the way down would open
a window in which a lid-closed Mac could sleep. The helper now carries
`FFD_HELPER_VERSION` and `setEnabled(true)` reinstalls on a mismatch, so the cost of a
helper change is one administrator prompt on the next enable.

**Verified live on 2376 and 2377**, with the lid physically closed (`AppleClamshellState =
Yes`) and on AC:

- No sleep event at any point, including across the app replacement by the 2377 install.
  The helper log gained no `normal sleep restored` line.
- The lock screen was captured at full resolution, one typed character appeared as a dot in
  the password field, and a delete cleared it, with `session-state` reporting
  `SESSION_LOCKED` throughout.
- A capture came back entirely black while the display reported `Online: Yes` and
  `displaysleep 0`, after the assertion chain had a gap during the app replacement.
  `/usr/bin/caffeinate -u -t 2` restored a full frame. `src/remote-p2p/desktop.ts` already
  does exactly this on `SESSION_LOCKED`, and `begin()` runs `ready(true)` before its first
  capture, so the phone's first frame takes that path.
- `check_permissions` returned `accessibility: true` and `screen_recording: true` after the
  rebuild, with `attribution: host` and `host_bundle_id
  ...localtest.accessibility`.

Validation: 20 server-mode tests (7 new: grace inside the window, past the window, the
window length being configurable, battery beating grace, an out-of-date helper replaced, a
helper with no marker replaced, a current helper not reinstalled, and a clean shutdown not
releasing the hold); `tsc --noEmit` clean; full backend suite 1739 pass / 12 fail / 4
skipped with **no new failures** (the 12 are the known families); packaged smoke passed;
installed 2377, health 401 at 16 s. Rollback bundle
`/Volumes/Personal/Developer/FarFromDesk/Builds/local-lid-grace-2377/local-2376-rollback.bundle`.

Still not tested, and not claimed: relock after display sleep mid-session, fast user
switching, and the login window, which the code refuses by design.

**The last open question, tested and passing.** With the charger in, the monitor
unplugged and the lid shut, `system_profiler` listed one display (the built-in Retina
panel, `Online: Yes`), `session-state` returned `UNLOCKED`, `pmset -g` returned
`SleepDisabled 1`, and a driver capture returned a full 269,908-byte frame of the live
desktop with the panel shut. A laptop with nothing attached and the lid closed stays
usable, and no dummy display adapter is needed. The earlier all-black frame was the lock
screen turning the display off after idle, not a missing display.

**And the battery rule verified itself by accident.** The owner unplugged the charger
during the test: the helper logged `10:13:42Z normal sleep restored (on-battery)`, and
`pmset -g log` shows `15:44:16 Clamshell Sleep` 34 seconds later, then a
`15:54:57 Maintenance Sleep`. Plugging back in produced `10:30:06Z lid-closed sleep
disabled`. Both directions of the battery transition, unverified since 2325, are now
confirmed on live hardware. The cost is worth stating plainly: unplugging a closed Mac
sends it to sleep within about half a minute, remote control goes down with it, and `womp`
is 0 on battery, so only physical input brings it back.

FileVault is on and there is no auto-login, so a restart still requires the owner
physically; no code change affects that.

### 2378 and 2379 closed two gaps left by 2377

Live verification then failed, and both causes were real defects rather than test noise.

1. **Nothing under `native/` could ship.** The `ffd ship` stage copies the whole backend
   from the *installed* app and overlaid only `dist/` and `skills/`, so
   `native/server-mode/helper.sh` stayed at its old bytes inside a build that had
   rewritten it in the checkout. The version guard then refused with "The bundled server
   mode helper is not the expected version", which is the guard working. 2378 overlays
   `native/` from the checkout with `ditto`, which merges and therefore leaves the
   compiled helpers that exist only in the installed app alone. `script/prepare_desktop_backend.mjs`
   builds a payload this workflow never consumes, so it is not the source of anything shipped.
2. **The install could write the files and load nothing.** `bootout` is asynchronous, and
   bootstrapping the same label while the old job is still going away fails with
   `Bootstrap failed: 5: Input/output error`. 2377 did exactly that: helper and plist
   written, no daemon loaded, `SleepDisabled 0`, and server mode rolled back. 2379 makes
   the script wait for the old job, retry once, and verify with `launchctl print`; and
   `setEnabled(true)` now reinstalls when the daemon is not loaded, not only when the file
   differs, so a file with no job behind it cannot leave server mode reporting itself on.

Verified after 2379, on this machine: the daemon is loaded (`active count = 1`,
`state = running`, pid 96932) with the version 2 helper; `SleepDisabled 1`;
`/api/preferences` reports `enabled: true, lidSleepDisabled: true, active: true,
heartbeatAgeMs: 1990, graceRemainingMs: 7198010`; the helper log shows
`2026-11-03T10:05:42Z lid-closed sleep disabled (server mode on, on power)` after the
bootout/restore pair at 09:56:24Z; and `helper.sh --once` against the real state file
returns `reason=ok sleep=1`. Server-mode tests are 21, `tsc` clean. The grace window
itself is covered by unit tests and by a live decision probe with a backdated state file;
it was not exercised by a real six-minute app outage.

## A closed lid does not lock this Mac, and nothing here ever had the password

The owner asked, after the lid run worked, whether opening the lid still needs a password.
It does not, and the finding is bigger than the feature: **this Mac is set never to
require a password after the display turns off or the screen saver starts**, so anyone who
opens the lid gets the desktop. Recorded in full in
`docs/remote-control-lock-screen.md`; the load-bearing evidence:

- `sysadminctl -screenLock status` returns `screenLock is off`, and
  `defaults -currentHost read com.apple.screensaver` has no `askForPassword` key at all.
- `pmset -g custom` reports `displaysleep 0` on both AC and battery, so the display never
  times out by itself and even the display-off trigger cannot fire.
- `loginwindow` logs the lid behaviour directly. Six lines inside eight minutes on
  3 November, at 16:25:37, 16:29:32, 16:30:44, 16:32:10, 16:32:50 and 16:32:52:
  `clamshellStateChanged: | clamshell closed, but screen is not locked.  Ignoring`, and
  the same for opened. The session stayed `UNLOCKED` throughout, matching the lid-shut
  capture that returned the live desktop rather than a lock screen.

So closing the lid has never locked this Mac, with or without FarFromDesk, and server mode
does not weaken it: the helper only removes the sleep that used to pause the machine.
Manual lock (Control-Command-Q) still works, and that is the state where capture and
typing were verified.

The owner then turned the requirement on, which is worth keeping but does **not** solve the
lid. `sysadminctl -screenLock status` moved from `screenLock is off` to
`screenLock delay is immediate`, and `loginwindow` logged `passwordDelay = 0` at 17:23:33.
The lid was shut at 17:24:00 and `loginwindow` logged it again: `clamshell closed, but
screen is not locked.  Ignoring`, with `session-state` returning `UNLOCKED` six times over
the following minute. The lock follows **display sleep**, not the clamshell, so a lid close
alone never triggers it while `displaysleep` is 0. `/usr/bin/pmset displaysleepnow` locks
within four seconds by contrast. Putting the display to sleep when the lid closes is
therefore the fix, not the checkbox.

Locked with the display asleep is the state the phone meets, and it was measured there:
the capture came back 14,987 bytes and entirely black at 999x650, and
`caffeinate -u -t 2` followed by a second capture returned 655,103 bytes showing the real
lock screen (date, time, account tile, `Enter Password`), with `session-state` still
`SESSION_LOCKED`. `src/remote-p2p/desktop.ts` already does exactly that on every
`SESSION_LOCKED` frame. Server mode held throughout: no sleep event in `pmset -g log`,
`SleepDisabled 1`.

Nothing in the product asks for, keeps or logs the Mac password, and the lid run never
needed it because every probe returned `UNLOCKED`. The password the app owns is the
per-connection remote password in `src/remote-p2p/host.ts`, a different secret.

Stale claims this corrected, all of which had said the capability was absent:

| File | Was | Now |
| --- | --- | --- |
| `docs/reference.md` | "Closed-lid operation requires Apple's supported powered external-display setup; no unsupported lid override or system-wide sleep setting is installed." | Describes server mode holding lid sleep off on AC, with the 5-minute and 2-hour thresholds, and states that neither setting touches the Mac password |
| `README.md` | "The awake option prevents idle sleep; it does not override every closed-lid condition." | Lid-closed works with server mode on AC and no external display; the lid still does not lock by itself |
| `MAC-APP.md` | Keep-awake "does not bypass ... unsupported lid-close behavior" | Separates keep-awake from server mode and says server mode never handles the Mac password |
| `docs/TROUBLESHOOTING.md` | "Idle-sleep prevention does not override every closed-lid/manual-sleep condition." | Nothing wakes a sleeping Mac remotely; server mode keeps a closed lid awake on AC and holds 2 hours after the app stops |
| `docs/coordinator-instructions.md` | "Do not claim to ... bypass lid-closed sleep" | Agents may rely on lid-closed operation on AC with server mode; must not claim it on battery, after a reboot, or that a closed lid locks the Mac |
| `desktop/lib/screens.dart` | "restores normal sleep within minutes if FarFromDesk stops, the cable is unplugged, or you turn this off" | Seconds for turning it off or unplugging (helper interval is 5 s), up to two hours after the app stops |

The `screens.dart` wording ships with the next build, since it is Flutter UI text.

## 2381 — the lid locks, and a locked Mac hands over the link (`local-local-lid-lock-2381`)

The owner closed the lid with `Require password` set to Immediately and the Mac stayed
unlocked, which is the finding recorded above: the lock follows display sleep, never the
clamshell. Two pieces close it, one in each direction.

**The helper locks the screen.** Helper version 4 reads `AppleClamshellState` each pass and
runs `pmset displaysleepnow` on the open-to-closed transition. Once per close, and only
while the decision is `ok|grace`: on battery the Mac sleeps by itself and a stopped app
restores normal sleep, so in both of those cases the lock arrives without help.
`previous_lid` starts empty rather than `open`, so a helper that comes up with the lid
already shut locks on its first pass. `SERVER_MODE_HELPER_VERSION` is 4 so the guard
replaces an older helper on the next enable. `test/server-mode.test.ts` is 26 tests.

**Version 3 did not work, and the reason matters.** It hardcoded `/usr/bin/ioreg`. ioreg is
in `/usr/sbin`, so `lid_state()` returned `unknown` on every single pass, the lock never
fired once, and nothing anywhere said so: the watch loop turned a missing tool into a
silent no-op. The fakes in the test file all inject their own tool paths, so no test could
see it, and 25 green tests said nothing. Found by running the installed helper live against
the real lid and noticing there was no log line at all. Version 4 fixes the path, logs once
when the lid cannot be read, and the suite now asserts that every absolute tool path the
helper hardcodes exists on this machine, which is the check that would have caught it.
Measured after the fix, with the lid shut: `lid closed; display off so macOS locks the
screen`, and `session-state` went `UNLOCKED` to `SESSION_LOCKED` within five seconds.

**A locked Mac refuses screen actions and sends the link.** `src/session-lock.ts` holds
`sessionLocked()` and `screenLockGate()`, wired into `/api/master/desktop-control`,
`/api/master/mac-control` and `/api/session/desktop-control` beside the permission gate.
Synthetic input does reach a locked Mac, which is the problem: it lands on the lock screen,
and typed text most likely lands in the Mac password field. So the action stops and the
owner is sent the same link and code `control my screen` sends, which the remote session
can use to type the Mac password at the lock screen. `stop`, `status` and
`check_permissions` stay allowed so a locked Mac can still be diagnosed. A missing probe,
an unset remote password, a host that will not start and a failed delivery all still refuse
the action, and the message names which one happened. Because each new link invalidates
the last, one link stands for 60 s so a retry loop cannot bury the owner in dead links.
`test/session-lock.test.ts` is 9 tests, and the installed build was checked live against a
locked Mac: `sessionLocked` returned `true`.

Two honest limits. The helper is replaced on **enable**, not on launch, so a machine that
already had server mode on keeps the old helper until the owner turns the setting off and
on once, which costs one administrator prompt; the alternative was an admin dialog
appearing at login where nobody is looking. And `native/session-state` is a compiled
binary that exists only in an installed payload, not in the source checkout, so running
the backend straight from `src/` leaves the gate inert.

Validation: 2380 staged and installed at 17:51 without the link cooldown, 2381 at 17:54
with it, and 2382 with helper version 4 after the lid lock was measured working.
`tsc --noEmit` clean, `flutter analyze` clean, backend suite 1750 pass with the 12 known
failures and no new ones.

## What real desktop actions actually do (3 November 2026, build 2382)

Driven through the installed build's own action layer on the owner's Mac, in the same
order the route uses (lock gate first, then the action). Not the chat path: no model and
no binding token, so this proves the layer those two hand off to.

| Action | Result |
| --- | --- |
| `check_permissions` | `accessibility: true`, `screenRecording: true` |
| `list_apps` | works, real app list with Calendar, Claude, Comet and the rest |
| `open Calendar` | works, launched pid 11959, `window_ready: true` |
| `list_windows` | works; the window reports `onScreen: false` because the launch suppresses self-activation |
| `list_browsers` | works, Comet running with `directTabs: true` |
| `list_tabs` | works, 28 real tabs with titles and URLs |
| `read_tab` | works, 8.3 s, real page text back |
| `new_tab` / `close_tab` | opened `https://example.com`, found it as "Example Domain", `close_tab` returned `{closed: true, tab_id: 438992313}`, and the count went 28 to 27 |
| `read_window` on Calendar | 15 controls (menu bar, `Continue`, toolbar, `Search`, three view buttons) plus a valid 1366x717 frame at `backingScale: 2` |
| `click` on Calendar's `Search` | sent in `background` mode, answered `effect: unverifiable`, and nothing changed |

Three things that matter for agent reliability, all measured:

1. **A read straight after `open_app` can come back `elementsEmpty`** with
   `axDegradedReason: ax_window_unresolved`. A retry once the window settles returns the
   full control list. So the agent must re-read, not conclude the app is unreachable.
2. **A pre-launch reference goes stale the moment the app gets a new pid**: `list_windows`
   on the reference from before the launch fails `DESKTOP_APP_STALE`. That is the tool
   working as designed, and the rule is to discover again.
3. **A background click may not land on a window that is not on screen.** Calendar
   launched with self-activation suppressed, so its window was behind, and the click was
   accepted without a verifiable effect. The documented remedy is one `deliveryMode:
   foreground` retry, which brings the window forward and is visible to the owner.

## Why a Mac request became a code review (3 November 2026)

Two live companion transcripts failed in the same shape. "Show me opened apps" and
"Can you open the notes" were followed by "Write a notes about tomorrow meeting" and
"Yes make it open", and the brain answered with task-contract language ("I could not
update the contract. Please send the correction again.", "Please review this task before
it starts.") or with a sentence no code contains ("Notes is not open right now").

Three separate causes, each read from the live `bridge.sqlite` before it was fixed:

1. **The task-contract flow ran first and claimed almost everything.** `src/router.ts:450`
   consults `TaskContracts.shouldHandle`, and `src/task-contracts.ts:97` returns true for
   every message while a contract is pending. The only guard in front of it was
   `MetaBrain.claimsDevice`, which required a resolvable app, so an inventory request and
   any answer such as "Yes make it open" fell into the coding classifier
   (`src/task-contract-model.ts:35`, a prompt with no Mac concept). Its `pass` decision on
   an edit then answered "I could not update the contract" (`src/task-contracts.ts:163`),
   which is why two turns in a row said it.
2. **A running app with no titled window was invisible.** `DesktopControl.targets()`
   dropped every app without a window, and the prompt is told that `devices` is what is
   open on the Mac and that naming anything else must become `clarify`. So a running Notes
   with no window left the model no legal plan, and it wrote its own "Notes is not open
   right now" on the clarify branch. Nothing compared that sentence to the driver.
3. **Writing into an app had no path at all** unless the owner typed "in Notes": the
   deterministic `type` pattern requires the app name, and the model may not name an app
   outside `devices`. Fixed by the reviewed app tool packs (see "App tool packs" below): a
   bare write into Notes now runs a written-down sequence instead of a blind type.

What changed:

- `claimsDevice` now claims an app inventory and a note-writing follow-up that names no
  app, and `MetaBrain.awaitingAnswer` stops the contract flow from taking the answer to a
  question the brain itself asked. A `pass` on the edit path is now returned as
  `{kind: 'pass'}` instead of being answered and consumed, so a pending contract no longer
  swallows unrelated turns.
- `targets()` keeps running apps with an empty window list, and the prompt says a listed
  app with no windows is open but has not drawn one.
- `executeDevice` saves what the driver reported per destination, and that sentence
  replaces model prose when the reply describes the state of the app the driver just
  handled. Ordinary talk about the app is left alone; the fact expires after ten minutes.
- A command meant for another subsystem (`/muse`, `/claude`, `/help`) is no longer treated
  as an answer to a pending contract. It used to be answered "The task or connection
  changed. Send the task again. Nothing was sent." and the command never ran, because the
  stale-connection check ran before the slash-command pass. Now the command goes through and
  the stale row is dealt with on the next real turn.

Evidence, with the harness at `test/brain-conversation.test.ts` replayed against the tree
before the fix (`git archive HEAD` into a scratch copy, HEAD `210abd2`) and after it:
**five of the seven tests fail before it and pass after** (the four transcript tests plus the
subsystem-command one); the other two (ordinary talk about the app is not replaced, and a
bare "write the failing test" keeps its contract review) pass on both, and guard the new
rules from over-reaching. Full suite 1780 pass / 12 known failures / 4 skipped.

## App tool packs: reviewed tools per app, and intent-to-tool retrieval (3 November 2026)

The owner's direction: "we can give it pre-built tools so that it doesn't have to find
everything on the runtime... Suppose I am working on the Notes app, it should load that tool
of the Notes app and then it can use it in the runtime."

**Why it was needed, measured live.** On build 2384 the replayed transcript
"Could you open notes" -> "Write a notes about tomorrow meeting at 10pm woth ashitosh"
answered **"Typed in Notes."** while the text had landed in the Notes *search field*: the
window was titled `Search - No Results` and the tree held `AXTextField = "Tomorrow meeting
at 10pm"`. The reply was a claim no code had verified.

**What the pack holds.** The exact sequence that was proven live with the driver's own
`run_steps`: `press_key escape` (leave the search field), `click {role:"AXButton",
name:"New Note"}`, `type_text {role:"AXTextArea", text:...}`. Two measured details are
encoded: a name-only click on "New Note" is refused because two elements match it (an
`AXButton` and an `AXMenuItem`), so the role is required; and the whole batch needs a named
window, because the driver refuses an observation it cannot attach to one.

**Code.**
- `src/app-tools/types.ts`: `AppTool` (name, pack, app, bundleId, description, args,
  examples, keywords, `plan`), `AppToolPlan` = driver steps or an AppleScript.
- `src/app-tools/packs.ts`: `notes_create_note`, `calendar_create_event`,
  `calendar_list_events`, plus `toolByName`, `packFor`, `appleDate` (refuses anything that is
  not `YYYY-MM-DD HH:MM:SS`) and `asStr` (AppleScript escaping). There is no `notes_search`:
  it was removed on 3 November after it failed live and typed into a note body (below).
- `src/app-tools/retrieve.ts`: `tokenize`, `toolText` (pack + name + app + description + arg
  names and descriptions + examples + keywords), IDF indexing, and `selectTools(text,{app,k,
  minScore})`. A tool is only in play when the owner named the app or the pack, when the app is
  the one in front, or when a matched word belongs to that app rather than to requests in
  general (`GENERIC`: add, create, find, get, list, make, new, open, put, run, save, search,
  set, show, use, write, today, tomorrow, week, time, name, body, title, start, end). Without
  that gate "add a retry to the sync loop" matched a calendar tool on the word "add"; without
  the third clause "schedule a call at 9 tomorrow morning" was dropped even though the app was
  not named. A bare "notes" is not a request to do anything.
- `src/app-tools/golden.ts` and `src/app-tools/golden-paraphrase.ts`: 25 utterances that must
  reach a named tool and 10 that must stay quiet, then 10 paraphrases that name neither the app
  nor any of its words and are only a Mac request because of the app in front.
- `src/app-tools/metrics.ts`: `evaluateRetrieval` (recall@1/3/5, wrong-first, missed) and
  `describeReport`, so retrieval quality is a number rather than an opinion.
- `src/app-tools/embed.ts` and `native/tool-embed.swift`: on-device sentence embeddings behind
  a five-second timeout, one process per request on stdin/stdout. `shortlistTools` appends the
  embedding candidates for the app in front to the lexical shortlist and never reorders it.
- `src/desktop-control.ts`: `packTool(scope,name,args,authorize)` runs one pack tool behind
  the same gates as `assist`, in the background, and returns only what the driver reported.
  An AppleScript tool reports `-1743` as `AUTOMATION_PERMISSION_REQUIRED` and names the exact
  System Settings pane; its own text never reaches the owner.
- `src/brain-device.ts`: the plan gains `action:"app_tool"` with `tool` and `args`, plus
  `notesWritePlan(app,body)`, which picks the Notes pack tool when the app is Notes and keeps
  the old `type` plan for every other app, so "write this where I am" does not become
  Notes-only. `deviceOutcome` maps a pack result to one permitted sentence ("Wrote the note in
  Notes.") and a failure to the ordinary refusal path.
- `src/meta-brain.ts`: the bare-write branch (`"now write the notes"`) now goes through
  `notesWritePlan`.

**Live verification on build 2385 (2026-11-03 20:47).** Replayed through the app's own
`POST /api/inbox-send`:
- "Could you open notes" -> "Opened Notes and brought it to the front." (`list_apps` shows
  Notes `active:true`).
- "Write a notes about tomorrow meeting at 10pm woth ashitosh" -> "Wrote the note in Notes."
  and the window then read `Notes - 8 notes` (was 7) with a list row
  `AXStaticText = "tomorrow meeting at 10pm woth ashitosh"` at 8:47 PM, note id
  `26B530F2-75CC-47BA-9B6B-52244E5914F5`. The claim and the fact now agree.
- "Show me all apps" -> the 15-app inventory. The first attempt failed with "Meta could not
  read that message right now." and the retry succeeded, so that was a transient model call,
  not routing.

**Tests.** `test/app-tools.test.ts` (9) asserts the pack invariants the research calls
decisive (unique `pack_`-prefixed names, at least three sentences with "Use this when" and an
explicit negative, two owner examples, four keywords, every argument described) and the
retrieval positives and negatives. `test/app-tools-retrieval.test.ts` (6) asserts the gate:
wrong-first 0, recall@5 1, recall@1 at least 0.9, recall@3 at least 0.95, every pack tool
covered by the golden set, the two original failures pinned, and a bare app name answering
nothing whatever the app in front. `test/app-tools-embed.test.ts` (5) holds the embedding layer
to widening only, and skips rather than fails when the compiled helper is absent.
`test/brain-device.test.ts` and `test/desktop-assist.test.ts` cover the plan, the refusal codes,
the whole step batch in one background call, and the "unknown tool or missing argument is
refused before the driver acts" case. `test/brain-conversation.test.ts` now asserts the
transcript takes the pack tool with the owner's words verbatim.

**Measured on 3 November 2026, with `native/tool-embed` built on this Mac.**
- Lexical scorer on the golden set: **recall@1 15/15, recall@3 15/15, recall@5 15/15,
  wrong-first 0**.
- The same request set through one embedding per tool: 14/15 top-1. As a reranker of the lexical
  shortlist it made things worse, **15/15 down to 11/15**, confusing `notes_create_note` with
  `notes_search`. As a standalone ranker on 16 tool descriptions it scored 4/8 top-1, and
  "write a note about tomorrow's meeting" put the note tool seventh.
- One line per example (not one per tool) with a per-tool best match is the better formulation:
  14/15 on the golden set, and on the paraphrase set it finds the right tool in the top three
  for 7 of 10.
- What it is actually good for, measured: the paraphrase set where the owner names neither the
  app nor its words. Lexical recall@5 **8/10**, lexical plus embedding candidates for the app in
  front **10/10**, and the golden set unchanged at 15/15. That union is what `shortlistTools`
  does, and it is why the embedding layer may only widen a shortlist and never reorder it.

- The shortlist now reaches the model. `MetaBrain.reviewedTools` asks the driver which app is in
  front (`DesktopControl.activeApp`, which reads `list_apps`, the only call that flags the
  frontmost app) and passes `shortlistTools` for that app into `InterpretInput.appTools`, capped
  at five. The prompt names the list, the new `app_tool` action, the rule that an argument name
  must be one the tool lists, and `now` (a `YYYY-MM-DD HH:MM:SS Weekday` stamp from `localStamp`),
  without which "tomorrow at 5" would be a guess. A message that matches nothing sends no list at
  all, and a failure to work out the app is never fatal.

**The unreviewed Notes search tool, removed on 3 November 2026.** `notes_search` shipped as a
three-step sequence (escape, click an `AXTextField` named Search, type the query). Live, the
shortlist reached the model, the model picked the tool, and the run answered "I could not do that:
the helper could not complete it." Two measured facts, from the driver itself:
- `click {role:'AXTextField', name:'Search'}` fails on an ordinary note window: *no AXTextField
  "Search" in Notes window; nearest: [45] AXButton "Search"*. The field only exists in the
  `Search – No Results` state, so the sequence was written against the one state that was not
  the normal one.
- Its third step typed with no target at all. Replayed by hand, that step **appended "roof" to the
  open note body**, because an untargeted keystroke goes wherever focus is. The note's own text had
  to be typed back in by hand (the undo ran one step too far and emptied the note first). The tool
  was removed rather than fixed: there is no measured working way to search Notes yet, and a
  reviewed tool that fails is worse than no tool.

Two rules came out of it, both tested.
- `AppTool.notFor`: requests a tool must never be offered for. `notes_create_note` declares
  "find a note", "look for a note", "search my notes", "show my notes". Without it, "find my note
  about the roof" shares the words *note* and *roof* with the create tool and would have made a
  second note. The retrieval layer ignores a phrase with fewer than two meaningful words
  ("where is that note" reduces to *note*) and a test asserts nobody adds one believing it guards.
- `AppPack` scoping: when the owner names an app or a pack, only that pack's tools are in play.
  Without it, "look for the note with the plumber number" reached `calendar_list_events` on the
  incidental words "look" and "number" once the Notes search tool was gone.
- Invariant test: every `type_text` step in any pack must name a role or a name. That is the check
  that would have caught the untargeted keystroke before it ran.
- Finding a note has a reviewed tool again, and this one cannot type. `notes_find` sends one
  read-only AppleScript to Notes and returns up to 8 titles whose name or body contains the
  phrase, capped at the first 300 notes. Nothing is clicked and no keystroke is sent, which is
  the property the removed UI search tool could not offer. Every osascript tool is now compiled
  in the suite (`test/app-tools.test.ts`, `osacompile -o`, which resolves the dictionary and
  needs no Automation grant), so `notes_find`, `calendar_create_event` and
  `calendar_list_events` are at least proven to be syntactically valid against the apps' own
  dictionaries. `notes_find` has still not been run: the first live run raises the same one-time
  Automation prompt as the Calendar tools.
- Read and write are separated by the owner's opening verb. `intentPolarity` in
  `src/app-tools/retrieve.ts` returns `write` for write/jot/save/note/remind/remember/record/
  log/capture/forget/hold/keep and `read` for find/search/look/where/read/show/list/tell/what/
  which, whichever comes first, and a tool whose `writes` is the opposite is dropped before
  scoring. Copulas are deliberately excluded: "my head is full" is not a read. Measured on the
  paraphrase set this took wrong-first from 3 to 1 and recall@1 from 0.6 to 0.8.
- A plan that refuses its own arguments answers with its own sentence. `packTool` wraps
  `tool.plan(args)` and rethrows as `APP_TOOL_ARGUMENT_INVALID`, which `deviceRefusal` turns into
  "I could not use those details, so I did nothing: <the tool's sentence>" with the failure code
  `invalid_arguments`. This is a real path, not a theory: the model works out the date and time
  itself, so "tomorrow at 5" arriving in a `start` field is a mistake it can make, and the guard
  also refuses an end time that is not after the start. Without it the throw escaped as the
  generic "I could not do that on your Mac".
- Every date in a plan is built from its parts. `appleDateAssign` emits `set d1 to current date`
  / `set day of d1 to 1` / year / month / day / `set time of d1 to <seconds>`; the day is set to
  1 first so that setting a 31-day month cannot overflow, and no plan contains a
  `date "2026-11-04 09:00:00"` literal, which AppleScript coerces with the Mac's own date
  settings and would therefore break on a machine set to another format. The suite asserts both
  (`appleDateAssign`'s exact text and that no plan contains `date "`), and every osascript plan
  is compiled with `osacompile` on every run.

- Example sentences must not be shared between a read tool and a write tool. Two collisions were
  measured, both of which put the wrong tool first: the note-search example reused the create
  tool's "the roof is leaking" sentence, and the calendar-create example contains "Ashitosh",
  which is also in the owner's note sentence. The first was fixed by rewording; the second is
  still there and is the one remaining wrong-first row.

**Not done yet.** Calendar tools are written and unit-tested but never run live, and the first
run will raise the macOS Automation permission prompt. `notes_find` is in the same position: its
AppleScript compiles against Notes, but it has never been executed against the app itself. The
shortlist wiring is unit-tested at transcript level (`test/brain-conversation.test.ts`:
the offer, the argument names, the clock, and that a coding app gets no list) and was watched live
on 2386-2389, where the model picked the reviewed tool it was offered.

### The eval harness, and sessions at once

`npm run evals` (`script/run_brain_evals.mts`) is the gate: it prints the retrieval scoreboard
both lexical and embedding-widened, runs the four brain eval files, and exits non-zero when a
number falls below what was measured. Measured on 3 November: golden 25 (15 with a tool, 10 quiet)
at recall@1/3/5 = 1 with wrong-first 0, paraphrases lexical 0.8/0.9/0.9 and 0.9/1.0/1.0 widened
with one wrong-first row, 25 transcript tests green. The paraphrase set is gated too, not just
printed, because it is the one that keeps the embedding layer honest; the floor it has to stay
above is 8 of 10 lexically, so the set does not quietly become easy.

`test/brain-sessions.test.ts` runs two sessions through one router and one brain, because
everything per-chat is keyed by destination and a per-session bug is invisible in a suite that
never runs two. It pins: each reply lands in its own chat (and the outbox row names it); the
device memory (`brain-device-last:<destination>`) does not leak, so a bare write in a chat that
never used an app asks instead of writing into the other chat's app; a pending coding contract in
one chat does not swallow another chat's turn; and the reviewed tools follow the Mac rather than
the chat, so both sessions are offered the front app's tools. Authentication is part of the
fixture: the second chat is an `owned-group:` + `destination-jid` one, because owner commands are
refused from anywhere else.

The multi-session harness is built at this level. `test/brain-fanout.test.ts` is the fan-out half:
it runs two authenticated sessions against the **real** `DesktopControl` over a fake driver that
holds `run_steps` open until the test releases it, so the serialisation being tested is the
shipped one rather than a stub. It pins what a second session gets while the Mac is busy: one
action at a time (peak in-flight 1), the loser is answered with "I am already doing something on
your Mac. Let that finish, then ask me again." instead of being dropped or wrongly told it
succeeded, the completion lands in the chat that acted and the refusal in the chat that asked,
and each session's `brain-device-last:<destination>` holds its own outcome — including the
loser's `ok:false` row, which is written on failure too.

The embedding cache is built: `native/tool-embed` learned a vectors mode (`{"texts":[...]}` ->
L2-normalised vectors, with the caller doing the cosine, so a dot product is the cosine), and
`embedRank` caches those doc vectors under `indexSignature(tools)`. A turn on a tool set whose
text has already been embedded sends only the owner's words: measured in `npm run evals`, **28
lines on a cold turn and 1 on the next**. The first turn on a set embeds the query and the docs
in one spawn, so nothing got slower to start; a changed pack changes the signature and re-embeds
rather than scoring against stale vectors. `embedStats()`/`resetEmbedCache()` exist so the tests
prove that instead of trusting the comment.

`npm run evals:live` (`script/live_transcript.mjs`, `--dry` to check the plumbing) replays the
same turns against the running app through `POST /api/inbox-send`, then waits and prints what the
app answered. That is the human half of the harness: the tests replay a transcript against a fake
driver, this one replays it against the Mac. Verified live on 2392 with "Could you open notes"
-> "Opened Notes and brought it to the front." and "Write a note that the embedding cache check
at 5pm" -> "Wrote the note in Notes.", with the note read back from the Notes window afterwards.

**Known retrieval limit, measured:** the Notes tool's examples include the owner's own note
sentence "tomorrow meeting at 10pm woth ashitosh", so a calendar request for a meeting with
Ashitosh still matches the Notes tool. The calendar tool ranks first, and the list is a shortlist
for the model rather than a decision, so this is a ranking wart and not the failure it would be
if the list were sent as the answer.

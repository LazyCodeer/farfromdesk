# Snapshot as of 31 October 2026

**Read the last section first.** The snapshot summary below is from 31 October and
the numbered sections after it supersede it one build at a time. As of 3 November
the current source is `/private/tmp/ffd-pr` (a real checkout on branch
`codex/local-desktop-work`, shared with other sessions), and the installed Local
app is **2356** (`local-settings-remote-2356`).

## Source and installation

Actual current Local source:
`/Users/sagar/Documents/ChatGPT/Personal/whatsapp-session-bridge/.local/social-session-wiring-20261031`

This is an ignored copied snapshot under the parent repository, not a Git worktree. `git status` walks up to the parent. Preserve dirty work. Inspect `desktop/macos/Flutter/ephemeral/Flutter-Generated.xcconfig` when verifying which directory supplied a build. Do not assume other Build folders or the main checkout are current.

Installed testing app: `/Users/sagar/Applications/FarFromDesk Local.app`
Bundle ID: `com.codecylabs.farfromdesk.localtest`
Last installed version: **2356**
Backend build ID: `local-settings-remote-2356`
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

Not verified: an actual lid-close run (whether macOS really stays awake with the lid shut), heat behaviour, and a battery-to-AC transition while enabled. `pmset disablesleep` is an undocumented switch absent from `man pmset`; if Apple removes it the settings pane reports "The sleep helper is not taking effect" instead of pretending to work.

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

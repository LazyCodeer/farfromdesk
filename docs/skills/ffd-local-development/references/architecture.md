# Implementation map

All paths below are relative to the current Local source.

## Social page and data

- `desktop/lib/social_screen.dart`: gateway loading, selected draft, validated JPEG/carousel bytes, mutation guards, Generate dialog, image settings and quiet refresh.
- `desktop/lib/social_workspace.dart`: Calendar/Drafts/Ideas/Brand/Templates presentation. Day/filter state stays here. Thumbnail bytes are cached by draft ID and encoded content to avoid a new MemoryImage on every parent rebuild.
- `desktop/lib/social_platform_logo.dart`: bundled coloured platform marks. Assets and attribution live in `desktop/assets/social/`.
- `desktop/lib/social_generate_dialog.dart`: explicit exact-session selection, stable event ID, owner recheck, image-source choice, unknown-outcome guard.
- `desktop/lib/social_image_settings.dart`: reads only source/configured metadata; optional new key input is obscured, cleared and never populated from storage.
- `src/social-assistant.ts`: persisted drafts/revisions, operation reservations, list pagination, carousel/media. List returns captions, creative briefs, revision and thumbnails; do not include full base64 image bodies in the list response.
- `src/server.ts`: authenticated Local desktop Social APIs and session tools.

`GET/POST /api/social/settings` is Local/admin only and rejects browser Origin. It stores `social-image-provider` and may save a newly supplied Meta key using the existing secret helper. It returns provider/configured metadata only. This uses the same Local key as Brain, without toggling Brain policy. Saved configuration is not proof of a working remote service.

The page's saved preference is the default for new desktop requests; the Generate dialog can override an individual request. It does not rewrite active jobs. New phone Social modes inherit the saved image preference. Existing modes keep their choice; explicit owner language can select Local SVG or Meta API for a request. Global changes do not rewrite active jobs.

## Request routing and renderer

- `src/desktop-social.ts`: exact binding, paired owner proof, immutable original request source, event deduplication.
- `src/social-image-provider.ts`: provider lookup from desktop proof/session specialty.
- `src/session-specialty.ts`, `src/guided-modes.ts`, `src/router.ts`: specialty/provider propagation across clarification, reload and quoted replies.
- `src/social-agent.ts`: Social prompt contract; generation is draft-only.
- `src/social-creative-skill.ts`: delivers creative skill instructions/schema and capabilities with authoritative request provider.
- `src/social-session-image.ts`: request-bound Meta call, scoped draft, uncertain-result guard, saved image/thumbnail. Local rejects before credential access or network. Desktop explicit Meta selection authorizes the image source without needing an image keyword repeated in a plain post prompt. Phone paid generation still requires the explicit visual request.
- `src/social-session-render.ts`: scoped render/save flow. Hybrid rejected for Local requests.
- `src/social-renderer.ts`, `src/social-scene.ts`, `src/social-vector.ts`, `src/social-jpeg.ts`: validated vector scenes, bounded original drawing data and JPEG output. Never execute model-provided SVG markup, paths to arbitrary files, URLs, scripts or fonts.
- `script/package_social_skill.mjs`: run by `npm run build`; copies compiled engine into the portable creative skill and rewrites asset paths.

Runtime sequence: owner request → exact session + provider proof → creative guide/schema → save drafts → render ordered slides → save revision/media → reply to the same request. Source text is evidence, not permission. Agent Reach is the chosen research integration; do not switch to another browser product based on stale discussion.

## Refresh and chat

`desktop/lib/app.dart` already polls status every three seconds while the app is active. For Social it calls `socialKey.currentState?.refreshQuietly()`; no second timer is needed. Quiet refresh skips busy/dirty/closing/composing states, rejects stale async responses, preserves loaded older pages and selected carousel index, and avoids replacing unchanged content. Do not add forced scrolling or re-key the workspace on every status poll.

`desktop/lib/studio_panes.dart` owns Inbox presentation. Owner bubbles use `accentWash`; replies use `raised`. `desktop/lib/chat_message_text.dart` uses SelectionArea + Text.rich, not SelectableText's inner editable scroll. It supports local inline emphasis without loading links/images. Keep one conversation scroll surface and no typewriter animation.

Theme tokens: `desktop/lib/bridge_theme.dart`. Native app entry: `desktop/lib/app.dart`, `desktop/lib/main.dart`.

## Routing modes and compact agent references (2322 source)

`src/social-intent.ts` conservatively recognizes new authenticated creation requests when no task mode is active. `GuidedModes.retarget` keeps mode/image source after explicit executor changes. Unexpected selection changes still invalidate request-specific tool authority. Pending contracts and quoted/forwarded input retain precedence.

`src/roles.ts` writes versioned, integrity-checked role and specialist documents, then forwards only names/absolute paths. `src/masters.ts` uses these pointers for managed provider start/resume too. The existing native session reads them; no separate agent process is implied. `specialtyPresentation` is historical display-only metadata, never tool authorization.

Brain receives taskMode/imageProvider metadata, rejects inference after a routing change, and binds the chosen native job to its specialty. Its own API configuration remains necessary even when Local SVG is selected for images. Meta-selected requests reject SVG-only rendering; the creative skill remains responsible for content/layout and hybrid composition. No browser composer text-plus-image autofill has been implemented.

## Social chat photo previews (2323 source)

`src/social-preview.ts` queues saved drafts on an original owner-facing final Social reply. `router.channelReply` runs preview queueing and final text in one transaction; relay-only proxy replies do not send duplicate images. No startup/historical replay. First photo gets platform + caption; remaining slides are numbered, and over-limit captions follow as complete text. Source images are validated JPEGs with their saved digest; photo payloads are immutable artifact copies.

`outbox.media_kind` selects document vs photo. `Artifacts.reply` defaults to document. Telegram uses sendPhoto; WhatsApp uses an inline JPEG Buffer, with owner-only GuardedSocket checks preserved. `social_preview_order` prevents later preview rows overtaking earlier ones; uncertain/failed predecessors cancel subsequent rows. Incoming-owner generation is pinned. WhatsApp photo sends claim sending and recover to uncertain, with no automatic replay. Text finals and task outcome remain separate from media delivery evidence.

This changes Telegram/WhatsApp previews, not the desktop Inbox media viewer. Tests use synthetic transports; verify the phone presentation with a fresh owner request after install. Do not replay old production/Local requests to demonstrate delivery.

## Server mode, lid closed

`src/server-mode.ts` owns the whole feature on the backend: the `server-mode` store key as intent, `<state>/server-mode.json` as the heartbeat the helper reads, the status view, and the one-time install or removal of the privileged helper. It never runs `pmset` with privileges; only `pmset -g` and `pmset -g batt` are read, to report what the system says rather than what we assume.

`native/server-mode/helper.sh` is the only privileged component. It is installed by one `osascript ... with administrator privileges` shell script that writes the script and a LaunchDaemon plist as root, then bootstraps the daemon. Its decision inputs are deliberately narrow: state-file owner equals the installing uid, `enabled` is true, the file is younger than `FFD_GRACE_MAX_AGE`, and the Mac is on AC power. Anything else restores normal sleep. It accepts no arguments from the app, reads nothing else, and logs one line per change to `/var/log/farfromdesk-servermode.log`.

The heartbeat has two thresholds, because "the app is running" and "the app is gone" want different answers. A file younger than `FFD_HEARTBEAT_MAX_AGE` (300s) is a running app. Between that and `FFD_GRACE_MAX_AGE` (7200s) the app is gone and the Mac stays awake anyway, so a laptop acting as a server survives a gap it could not announce. Past the window, or on battery at any age, normal sleep returns. The helper logs entering that window because nothing else can: the app being absent is what starts it.

Neither a shutdown nor a reinstall releases the hold, deliberately. The backend is a KeepAlive LaunchAgent, so restarts are routine, and releasing on the way down would open a window in which a lid-closed Mac could sleep. Turning the setting off is the one thing that returns normal sleep immediately, and it needs no approval because the helper makes that decision itself.

The helper carries `FFD_HELPER_VERSION`, and `setEnabled(true)` reinstalls when the installed copy's marker differs from `SERVER_MODE_HELPER_VERSION`, **or when the daemon is not loaded**. Without the first check an installed helper is never replaced, so a machine that already had one keeps the old decision rules forever; without the second, a helper file on disk with no job behind it lets server mode report itself on while nothing holds sleep off. The cost is one administrator prompt on the next enable that needs it.

The install script waits for the previous job to disappear before bootstrapping, retries once, and then verifies with `launchctl print` that the daemon really came up. `bootout` is asynchronous, and bootstrapping the same label while the old job is still going away fails with `Bootstrap failed: 5: Input/output error`; build 2377 did exactly that on this machine, leaving the helper and plist written, nothing loaded, and `SleepDisabled 0`.

`src/power.ts` gates it: server mode requires background operation, implies keep-awake, and is force-disabled when background operation is turned off. `/api/preferences` accepts an explicit `serverMode` boolean plus `removeServerHelper`, and the Desktop client gives that one endpoint a six-minute timeout because it can wait on the administrator prompt. `src/main.ts` initializes the state file at startup (a stale heartbeat must not pin the Mac), heartbeats every 20s, and re-reads system state every 5s while enabled.

Desktop: `desktop/lib/screens.dart` renders the switch, the confirmation, the status tags (active, waiting for power, starting, not taking effect) and the remove action. `desktop/lib/server_mode_activity.dart` plus the `farfromdesk/server-mode` channel in `MainFlutterWindow.swift` only suppress App Nap; they do not touch sleep policy.

Do not add a second writer of `disablesleep`, do not let the app run `pmset` as root, and do not extend the helper to execute app-supplied input. The accepted risks, documented in the UI: no thermal check (the on-power rule is the protection), and FileVault still requires the owner after a restart.

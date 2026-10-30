# Desktop control preview

The next FarFromDesk release adds optional macOS desktop functions through the existing authenticated coordinator connection. In **Settings > Remote control**, use the permission button to grant Accessibility. Coordinator app control becomes available when Accessibility is granted. Browser tab commands can separately require Automation access. Screen Recording is required for phone screen control and is optional for coordinator screenshots. Polling never prompts.

The installed app bundles its native helper and the pinned Cua driver. It does not depend on Mac Control Lab, Python, a development checkout, browser extensions or remote debugging. Windows and Linux report the feature as unsupported.

## Functions

Coordinators use `master_desktop_control`, or `ffd desktop REQUEST-ID` with JSON on stdin. `ffd master desktop REQUEST-ID` is also available. Calls require an open owner request; workers and the admin token cannot impersonate a coordinator request.

| Action | Input / behavior |
|---|---|
| `status`, `stop` | Read feature state; cancel pending work and clear targets |
| `list_apps` | Optional query; installed/running apps with appRef |
| `list_browsers` | Browser choices and direct-tab capability |
| `open_app` | Exact appRef and actionId |
| `list_tabs` | Explicit browser: comet, chrome, edge, brave, or exact supported bundle |
| `new_tab` | Browser windowRef, HTTP(S)/about:blank URL, actionId; existing window only |
| `focus_tab`, `close_tab` | Exact tabRef, actionId; cannot close the last tab in a window |
| `navigate_tab` | Exact tabRef, URL and actionId |
| `read_tab` | Exact tabRef; Accessibility text, restoring original tab selection |
| `list_windows` | appRef; native window choices |
| `read_window`, `chat_controls` | Native windowRef; bounded controls, snapshotId/controlIds |
| `click`, `type_text`, `press_key` | windowRef, fresh snapshotId/controlId, actionId, text/key where needed |
| `chat_action` | windowRef, new/draft/send chatAction, actionId; text or exact expectedDraft |

Start with `{"action":"list_browsers"}`, then `{"action":"list_tabs","browser":"comet"}`. Use the returned refs rather than names, positions or guessed IDs. Browser and native windows have distinct reference types. References belong to one request, expire after five minutes and are invalid after Stop.

Generate a UUID actionId once per logical mutation. The durable reservation is written before dispatch. A timeout means an unknown outcome: inspect the app, never retry with the same or a freshly invented action ID. Only hashed request/action keys and reservation markers are persisted, not text, URLs or credentials. Rediscover tabs after a mutation.

## App recipes and limits

Gemini and Claude recipes use exact observed roles and labels. Drafting requires an empty composer. Sending is separate, requires exact expectedDraft and explicit owner authorization. Inspect Claude's project/account context and preserve native initiation/trust restrictions. Never use UI actions to bypass a native refusal.

Dispatch is not proof of completion; read the resulting chat/window. Truncated chat trees are refused. Accessibility can omit virtualized, offscreen or custom-drawn content. Page reads require a unique matching page root and native window, exclude sidebar content and temporarily select the target tab. Avoid manual browser interaction during reads. Safari and Firefox have discovery but no direct-tab adapter.

Comet tab creation/navigation/read/cleanup was verified in the lab, alongside earlier authorized Gemini/Claude input tests. Integration checks are separate: unit/HTTP/widget tests, the real native host handshake, and platform packaging. CI cannot grant Accessibility or establish live third-party chat input on a user's Mac. The packaged FarFromDesk app needs its own grants.

## Lifecycle and distribution

The MIT Cua driver is pinned at 0.38.0. Packaging checks archive/executable SHA-256, and the helper rechecks the executable before launch. Vendor signature, license and dependency notices are retained. Telemetry/update checks are disabled. OpenBot application code and optional model detectors are not bundled.

The native app helper is the driver's actual parent. Embedded mode uses an owner-only random socket directory and parent-liveness input. Stop aborts pending work and terminates the owned chain. Connections stay warm for 60 idle seconds; restarts invalidate cached tokens. No arbitrary raw-driver tool is exposed.

Request scope is an application boundary, not an OS sandbox against hostile same-user code. Global input retains a focus-change race. UI text is untrusted, and credentials, security prompts and unrelated private content remain outside the supported workflow.

The existing macOS release pipeline uses ad-hoc signing and is not notarized. Updates may require permission reapproval. Developer ID signing is the distribution path for stable identity; this feature does not install a signing identity on users' machines.

## Release checks

Run `npm run check`, `npm test` with isolated WSB_STATE_DIR, and `python3 -m unittest discover -s script/tests`. In desktop/, run `flutter analyze` and `flutter test`. Mac packaging compiles the helper and verifies the driver. `node script/smoke_desktop_driver.mjs` runs before and after packaging, checking the real MCP handshake and host attribution without input or permission prompts.

Candidate CI uses desktop.yml with target=all and publish=false. Version allocation comes from release history. Stable publication remains behind the existing main/all-platform gate.

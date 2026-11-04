# Screen control on every platform — one session (4 November 2026)

You are the sole owner of this task. Read it completely before you touch anything, then work in
slices and report after each one.

## Why this exists

FarFromDesk already ships a Windows x64 and a Linux glibc x64 app (`docs/DESKTOP-DEVELOPMENT.md:83`,
`desktop/{windows,linux}`), and the UI, routing, approvals, installers and CLI adapters are
cross-platform. **Screen control is not.** On Windows and Linux the product falls back to the
portable CLI adapter and says so:

- `src/remote-p2p/service.ts:46` → `'Screen control works on a Mac for now.'`
- `src/platform.ts` `requirePortableCLI()` → `"Desktop session delivery is not supported by this
  platform adapter. Choose an exact saved CLI session."`
- `docs/DESKTOP-DEVELOPMENT.md:23,129` → Windows/Linux use the portable CLI adapter; desktop
  delivery/injection is not claimed.

The owner's instruction is that this must change before any new tool work on other platforms.

## Your working copy (do not share the other session's worktree)

Another session is editing `src/app-tools/**` in `/private/tmp/ffd-pr` right now. Work in your own
worktree so neither of you loses edits:

```sh
git -C /private/tmp/ffd-pr fetch --all
git -C /private/tmp/ffd-pr worktree add -b codex/platform-screen-control \
  /private/tmp/ffd-platform codex/local-desktop-work
ln -s /private/tmp/ffd-pr/node_modules /private/tmp/ffd-platform/node_modules
cd /private/tmp/ffd-platform
npx tsc --noEmit
```

Your branch is `codex/platform-screen-control`. **Authorised ownership:**

- `src/platform.ts`, `src/desktop-control.ts`, `src/mac-control.ts`, `src/remote-p2p/desktop.ts`,
  `src/remote-p2p/service.ts`, `src/session-lock.ts`, `src/server-mode.ts`, `src/app-liveness.ts`
- new files under `src/platform/**`, new native helpers under `native/**`
- `test/desktop-assist.test.ts`, `test/brain-fanout.test.ts`, `test/server-mode.test.ts`,
  `test/session-lock.test.ts`, and new `test/platform-*.test.ts`

**Off limits:** `src/app-tools/**` and `test/app-tools/**` (the other session owns them), the
router/brain files (`src/router.ts`, `src/meta-*.ts`, `src/brain-*.ts`, `src/task-contracts.ts`),
`native/cua-driver/**` (vendor signature — see below), and the ship script.

Do not change the `packTool` signature or behaviour in `src/desktop-control.ts`; that seam belongs
to the other session and must keep compiling.

## Hard rules

1. **Never weaken the macOS behaviour.** Every existing Mac test must stay green, and the suite
   count must not drop. Run `npm test` before you call a slice done.
2. **Do not commit, do not build, do not ship.** The integrator does that after review.
3. **Compiled, unit-tested and ran-live are three different claims.** Write the exact one you have.
   A Windows or Linux path you have never executed on that OS is "compiled and unit-tested", never
   "works".
4. **Do not add a dependency to `package.json`** without flagging it for the integrator first.
5. **No secrets in code, logs or reports.**
6. macOS is your only local host. Its suite must stay green, and it must not start claiming that
   Windows/Linux control works where it does not.

## The capability inventory (verified 4 November 2026)

| Capability | macOS implementation | Windows counterpart | Linux counterpart |
|---|---|---|---|
| UI steps: click, type, key, hotkey, scroll, menu | cua-driver accessibility steps, `run_steps` | UIA: InvokePattern, ValuePattern, SendInput | X11: XTest; Wayland: libei/portal |
| Window/app enumeration, focus, frame | `list_apps`/`list_windows`/`bring_to_front`/`set_window_frame` | UIA tree walk + `SetForegroundWindow` | AT-SPI2, wmctrl/GNOME helper |
| Accessibility tree read | `get_accessibility_tree` (AXUIElement) | UIA tree | AT-SPI2 tree |
| Screen capture | macOS capture helper (`src/mac-control.ts:40`) | desktop duplication / GDI | X11 XGetImage; Wayland ScreenCast portal |
| App activate | `/usr/bin/open -b -a` (`src/desktop-control.ts:144` `activate`) | `Start-Process`/`ShellExecuteEx`, then UIA focus | `gtk-launch`/`xdg-open`/D-Bus activation |
| Permissions report | Accessibility + Screen Recording (`check_permissions`) | none to prompt; **UIPI blocks elevated windows** | X11: none; Wayland: portal consent per session |
| Locked-session detection | `native/session-state` probe + `src/session-lock.ts` gate | `OpenInputDesktop` / `WTSQuerySessionInformation` | logind `Session.LockedHint` over D-Bus |
| Keep awake / display sleep | `caffeinate -d -w`, `-u -t 1` (`src/remote-p2p/desktop.ts:51,61`) | `SetThreadExecutionState` | `systemd-inhibit`, D-Bus `org.freedesktop.ScreenSaver` |
| Server mode (lid close, sleep disabled) | launchd helper, `src/server-mode.ts:114,192,247` | Windows scheduled task / service | `systemd --user` unit |
| Browser tabs and page text | JXA `native/desktop-browser.js` (`src/desktop-control.ts:73`) | UIA/CDP against the browser | D-Bus/AT-SPI or CDP |
| **Already portable** | one-action-at-a-time busy gate, sensitive-app bans, refusals, retrieval, remote password | same code | same code |

Mac-only guards to remove or replace:

- `src/desktop-control.ts:145` `view()` `supported: platform === 'darwin'`; `:201`, `:260`, `:432`
  throw `DESKTOP_MACOS_ONLY`; `:144` the default `activate` shell out to `/usr/bin/open`; `:294`
  the native helper directory.
- `src/mac-control.ts:37,40,42,67,78` — the whole view and every capture/permission path.
- `src/app-liveness.ts:18,34` — non-darwin returns `{codex:true,claude:true}` (a claim, not a check).
- `src/server-mode.ts:114` `get supported(){return this.deps.platform==='darwin';}`.
- `src/cli.ts:174,184` — service install/stop through `launchctl`.
- Adjacent, not screen control, but the same shape: `src/local-email/local-runtime.ts:15`,
  `src/session-activation.ts:29`.

## What we already have underneath

The vendored driver is a Rust workspace whose platform crates are confirmed upstream
(`libs/cua-driver/rust/crates/` — **not** top-level `crates/`, which our notices file overstates;
a separate `cua-driver-uia` crate now also handles some Windows UIA code):

- `crates/platform-windows` — UIA tree walk, app and window enumeration, InvokePattern click and
  ValuePattern set-value through Interface-Agent, background input and a cursor overlay through
  trope-cua.
- `crates/platform-linux` — Wayland `shell_helper`, libei input acknowledgement, GNOME per-window
  capture (the T3 Code patches).
- `crates/platform-macos` — what we use today.

Upstream's own support matrix: **Windows = Supported** (Win32, UI Automation, native input, window
messages); **macOS = Supported**; **Linux X11 = Supported with limits**; **Linux Wayland = Supported
with limits, opt-in** via `CUA_DRIVER_RS_ENABLE_WAYLAND=1` (otherwise XWayland routes). Install:
`irm https://cua.ai/driver/install.ps1 | iex` on Windows, `curl -fsSL https://cua.ai/driver/install.sh`
on Linux/macOS. An end-to-end run needs an interactive console or RDP session.

Tool parity to design against (verified in the driver's own reference):

- ~28 tools exist identically on all three platforms (`list_apps`, `list_windows`, `launch_app`,
  `kill_app`, `bring_to_front`, `set_window_frame`, `invoke_menu`, `get_window_state`,
  `get_accessibility_tree`, `verify_state`, `parse_visual_regions`, `get_desktop_state`,
  `get_screen_size`, `get_cursor_position`, `zoom`, `click`, `double_click`, `right_click`, `drag`,
  `scroll`, `move_cursor`, `type_text`, `press_key`, `hotkey`, `set_value`, `clipboard_read`,
  `clipboard_write`).
- **Windows-only:** `debug_window_info`. **Linux-only:** `mouse_button_down`, `mouse_button_up`,
  `mouse_drag`, `parallel_mouse_drag` — so press-and-hold has no Windows equivalent.
- **`cua-driver permissions` is macOS-only.** Windows and Linux have no grant step at all.
- Targets are `{kind:"window", pid, window_id}` or `{kind:"desktop", display_id:"primary"}`;
  `delivery_mode` is background (default) or foreground; results carry `verified`, an `effect` of
  confirmed / unverifiable / suspected_noop, and escalation hints.

`docs/skills/ffd-local-development/scripts/ffd:107` states: *"cua-driver is deliberately never
touched: it carries the vendor's signature."* So **do not modify the driver**. Treat it as a binary
dependency and establish, as part of Phase 0, how the Windows and Linux driver artifacts are obtained
and signed — that is a deliverable, not an assumption. Note the vendored tree here has only the
licence and notices files; the binaries are fetched per platform.

## Researched platform facts and limits (4 November 2026)

These were fetched from primary sources on 4 November 2026 (`web_search` is broken in this
environment; `web_fetch` was used). Re-verify anything that decides code; the ones marked
**[unverified]** are exactly that.

**The asymmetry that shapes the design.** macOS asks the user for Accessibility and Screen Recording
(TCC). **Windows asks for nothing** — the model is integrity levels plus UIAccess, and UIPI stops a
medium-integrity process from driving an elevated (medium+/high) window. UIAccess needs an
Authenticode-signed binary installed under Program Files with `uiAccess="true"`, and packaged/UWP
apps can never have it. So on Windows **our tool layer is the only policy**: the permission gate,
the sensitive-app list and the refusals must be enforced by us, because the OS will not. Linux's real
analogue is the XDG RemoteDesktop portal, which does ask (`Start()` shows a dialog and returns the
granted device set: 1 = keyboard, 2 = pointer, 4 = touchscreen; `persist_mode` 0/1/2 with a
`restore_token`; input through EIS, capture through ScreenCast + `OpenPipeWireRemote` in the same
session). polkit is elevation on the system bus, not app-to-app consent.

**Windows**

- Widget trees: UI Automation (`CUIAutomation` COM, `IUIAutomation*`), available with no extra
  permission for same-integrity apps. **There is no Node/Electron UIA library** — the practical
  routes are a native helper or vendoring a server (below).
- Data access is per-app and there is no cross-app scripting language: Outlook classic COM (requires
  classic Office installed), Microsoft Graph for mail/Teams/OneNote (Entra app registration;
  OneNote is delegated-only, no app-only auth), **new Outlook has no COM at all** (web add-ins only),
  Windows Mail/Calendar are retired, Notepad and Explorer have no data API.
- If a PowerShell plan kind is added: `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
  <tmp.ps1>` with `-File` last and literal string args; `-EncodedCommand` is Base64 of a UTF-16LE
  string; external exit codes other than 0/1 collapse to 1, so scripts must end `exit $LASTEXITCODE`;
  `-NonInteractive` turns a prompt into a terminating error instead of a hang; the default apartment
  is STA (right for Office COM); the MSIX/Store build of PowerShell is a sandboxed trap. Server-side
  Office automation is unsupported by Microsoft **[unverified — the KB257757 pages now 404]**; our
  app runs in the logged-in interactive session, which is what makes Office COM workable.

**Linux**

- Widget trees: AT-SPI2 over the session D-Bus (`org.a11y.Status.IsEnabled`) — the same protocol on
  X11 and Wayland, with toolkit-dependent coverage. **Electron/Chromium apps expose zero children
  unless relaunched with `--force-renderer-accessibility`.**
- Input: X11 has XTest, but window-targeted `xdotool` events use `XSendEvent` and many apps reject
  them. `wtype` needs a compositor virtual-keyboard protocol KWin does not implement. `ydotool` uses
  kernel uinput, needs `/dev/uinput` (root-equivalent) and is AGPLv3. libei is the supported path and
  is explicitly **not** fire-and-forget: the client waits for the compositor to grant devices.
- Driver-side limits to write down, not discover later: KDE/KWin is Experimental (read-only helper),
  Hyprland is Experimental (optional plugin, off by default), niri needs 25.08+ and offers no
  background input, GNOME/Mutter needs the bundled WinRects Shell helper and one Shell restart, Sway
  refuses focus-bound raw background input, and Chrome/Edge on Linux X11 answer
  `browser_input_trust_unavailable` for trusted pointer input. Flatpak/Snap confinement blocks the
  host AT-SPI bus and host app data without risky `--socket=session-bus` grants.
- Data: Evolution/GNOME Calendar/To Do/Contacts sit on **EDS** (libecal/libebook + D-Bus), Kontact on
  **Akonadi** (interface names **[unverified]**), Thunderbird has no scripting API (mbox by default,
  Maildir incomplete, SQLite readable with the app closed), and local Maildir/mbox files are fine.
  LibreOffice Calc text cells cannot be written through AT-SPI (numeric Value only).

**Ready-made options, for the record.** The one credible Windows server is
`CursorTouch/Windows-MCP` (MIT, 11k★, Python 3.14+, stdio/SSE/HTTP, UIA snapshot plus PowerShell,
clipboard, registry; its own docs say user takeover is best-effort, "not a security boundary").
Cross-OS: `AmrDab/clawdcursor` (MIT, TS, accessibility + OCR, verifies every action);
upstream `trycua/cua` itself. **There is no production-grade Linux AT-SPI MCP server** — the best is
1★ with a single commit, and the alternative is AGPL-3.0 and abandoned. Conclusion: our vendored
cua-driver is the best cross-OS bet for the mechanism; the product value is the policy layer above it.

**Known impossible, to be stated as refusals rather than attempted:** on Windows, elevated targets
without a signed UIAccess binary, packaged/UWP apps, new Outlook data, Windows Mail/Calendar data,
Notepad/Explorer data, server-context Office COM; on Linux, background raw input on standard Wayland
to an unfocused window, Electron trees without the relaunch flag, canvas/game UIs, Flatpak/Snap agents
reaching host apps. Both: there is no cross-app scripting layer to port to.

## Phases

**Phase 0 — inventory and contract (no behaviour change).**
Write `docs/screen-control-platforms.md`: the table above expanded, for each capability the exact Mac
call site, the Windows and Linux implementation, the permission model, and whether the driver already
provides it. Include the driver-artifact question (where the Windows/Linux binaries come from, how
they are signed, how `scripts/ffd` selects them) and the known honest limits (Windows UIPI; Wayland
portal consent; capture scaling). Exit: the document exists and names, for every row, either an
implementation or an explicit "not available, refusal is".

**Phase 1 — one seam.**
Add `DesktopPlatform` (a small interface: `id`, `activate`, `permissions`, `sessionLocked`,
`keepAwake`, `capture`, and whichever of the above needs a platform word) plus a `darwin`
implementation; select it in `src/platform.ts` on `process.platform`. Move the Mac-only branches out
of `DesktopControl`, `MacControl`, `remote-p2p/desktop.ts` and `server-mode.ts` behind it. The
existing constructors already take `platform` and `activate`, so tests can inject the platform: keep
them. Exit: **no behaviour change on macOS**, `npm test` green, and the Windows/Linux adapters still
throw or refuse explicitly.

**Phase 2 — Windows adapter.**
Implement the adapter, flip `DesktopControl.view().supported` / the `requirePortableCLI` gate for
`win32` only when the driver reports a working platform backend, and make `permissions()` report the
truth (nothing to prompt for; UIPI limit stated). Exit: `test/platform-windows.test.ts` green with a
fake driver on macOS, plus a written Windows verification checklist for T4/T5.

**Phase 3 — Linux adapter.**
X11 first (input, windows, capture). Wayland second, through the portal/libei path, with per-session
consent documented as a product constraint. Exit: `test/platform-linux.test.ts` green, plus the
X11 checklist and the Wayland limitations written down.

**Phase 4 — product parity.**
Permission onboarding per OS, Settings copy ("Mac control" → "Desktop control"), server-mode
equivalents (Windows scheduled task, `systemd --user`), locked-screen refusal with the remote link on
logind `LockedHint`, and the phone/remote screen path. Exit: a table in the doc saying exactly which
product features are live on which OS.

## Verification ladder (use these names)

- **T0 compiled** — `npx tsc --noEmit` clean.
- **T1 refused honestly** — the unsupported path returns a named refusal, not a silent no-op.
- **T2 unit** — platform tests pass with an injected fake driver on macOS.
- **T3 integration** — the adapter is exercised end to end against the fake driver through
  `DesktopControl` (the `test/brain-fanout.test.ts` pattern: a real `DesktopControl` over a fake
  driver, one action at a time).
- **T4 ran live** — executed on a real interactive desktop of that OS. GitHub's Windows runners run
  in session 0 with no interactive desktop, so Windows T4 needs a real machine or VM; Linux T4 can
  run under a virtual display (Xvfb) for X11, but Wayland needs a real compositor session.
- **T5 read-back proof** — after a write, read the platform back and show the change (what we did for
  the Notes writes).

## Commands

```sh
npx tsc --noEmit                              # T0
npx tsx --test test/desktop-assist.test.ts    # focused tests
npx tsx --test test/platform-windows.test.ts
npm test                                      # full suite: node script/run_node_tests.mjs all
npm run test:portable                         # the cross-platform gate
npm run evals                                 # retrieval gate (do not change its numbers)
```

The suite has 13 known pre-existing failures (`docs/skills/ffd-local-development/references/current-state.md`
names them). Do not "fix" them by deleting tests; if your change moves the number, say so and prove
which names changed.

## Report format

After each slice, report: slice name; files added/changed; the T-level you reached with the exact
command and result; what you did **not** verify and why; and any assumption that needs the owner
(a decision, a machine, a permission prompt). Keep it short and specific. Do not report a plan as
progress.
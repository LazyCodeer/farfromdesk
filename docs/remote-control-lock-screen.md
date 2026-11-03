# Phone control at the lock screen, and lid-closed server mode

Verified on 3 November 2026 against the installed Local build 2376 on the owner's
MacBook Air (Mac16,12, macOS with FileVault on). This resolves a contradiction that
had been sitting in the repository, and it records the first lid-close run.

## The contradiction this closes

The 0.9.1 release note states, in public: "Unlock your Mac from your phone. When your
Mac is locked, the lock screen stays visible and Type hides what you enter."
`remote-page/remote.js` says the same. Two engineering documents said the opposite:

- `owner-view-native-validation.md`: "No screenshot or input was attempted after that
  result. Unlock/relock and sleep transitions have not been tested."
- `owner-view-hackathon.md`: "Locked or unknown GUI state | Refuse capture/input and
  stop session; no password entry through Telegram".

The older owner-view path (one chosen window, same Wi-Fi) does refuse when locked, and
that is what those lines describe. The newer `src/remote-p2p` path claims to show the
lock screen and type into it, and nothing in the repository proved it either way. It
was an assertion in a code comment and a shipped sentence, not a test result.

## What was tested

The probe used the installed app's own bundled driver, so the TCC subject is the app
bundle the owner already granted and not a shell:

```sh
cd "/Users/sagar/Applications/FarFromDesk Local.app/Contents/Resources/backend"
node /tmp/ffd-probe.mjs perms     # check_permissions
node /tmp/ffd-probe.mjs capture /tmp/out.png
node /tmp/ffd-probe.mjs type x
node /tmp/ffd-probe.mjs key delete
```

`check_permissions` returned `accessibility: true` and `screen_recording: true`, with
`source.attribution: "host"` and `host_bundle_id:
com.codecylabs.farfromdesk.localtest.accessibility`. The driver's own note explains the
attribution: "these booleans reflect the HOST app's TCC grant (the driver is a child in
the host's responsibility chain)".

Conditions, all confirmed rather than assumed:

- `session-state` returned `{"unlocked":false,"reason":"SESSION_LOCKED"}` before, during
  and after every step below.
- `ioreg -r -k AppleClamshellState` returned `Yes`, so the lid was closed throughout.
- `pmset -g` reported `SleepDisabled 1`, and the only display online was the external
  BenQ at 1920x1080; the internal panel was gone.

## Results

| Step | Observation |
| --- | --- |
| Capture while locked | A full-resolution frame came back, showing the lock screen: date, time, the owner's account tile and the "Enter Password" field |
| Type one character | The captured frame showed one dot in the password field, where the previous frame showed the placeholder |
| Press delete | The field returned to the placeholder with the caret, and the session was still `SESSION_LOCKED` |

So synthetic keyboard input reaches the macOS lock screen and the lock screen can be
captured. The 0.9.1 claim holds for this machine and this build. The three captures were
kept at `/tmp/ffd-lock-before.png`, `/tmp/ffd-lock-typed.png` and `/tmp/ffd-lock-cleared.png`
and are deliberately not committed, because they show the owner's lock screen.

## Lid closed on AC power

This is the state the feature exists for, and it had never been exercised: every prior
sleep event in `pmset -g log` happened with server mode off or on battery.

With the lid shut and the charger connected, `pmset -g log` recorded no new sleep event.
The last entry before it remains `2026-11-03 06:57:44 Low Power Sleep ... Using Batt
(Charge:1%)`, which is the battery rule working as designed. `/var/log/farfromdesk-servermode.log`
showed no `normal sleep restored` line, and `caffeinate` plus the driver's own assertion
held display sleep off. The Mac stayed reachable and capture kept working.

## The display can go dark even though nothing slept

While the lid was shut and the session locked, one capture came back **entirely black**
(12,433 bytes against 623,899 for a real frame) even though `system_profiler` reported the
BenQ as `Online: Yes`, `pmset -g` said `displaysleep 0 (display sleep prevented by
cua-driver)`, and the driver held `PreventUserIdleDisplaySleep`. The black frame arrived
after the app was replaced by a build install, so the assertion chain had a gap while the
old driver died and the new one started. `pmset -g assertions` also showed powerd holding
`InternalPreventDisplaySleep named: com.apple.powermanagement.delayDisplayOff`, which is
the system about to turn the display off.

Declaring user activity restored it immediately:

```sh
/usr/bin/caffeinate -u -t 2   # then the next capture returned a full lock-screen frame
```

This is already what `src/remote-p2p/desktop.ts` does when it sees `SESSION_LOCKED`, and
`begin()` calls `ready(true)` before its first capture, so the first frame the phone gets
goes through that path. The comment there ("the lock screen turns the display off after
about a minute idle even under caffeinate -d; declaring activity keeps the frame from
going black") was an unverified claim; it is now measured, in both directions.

What is not covered: if the display goes dark while no session is connected, nothing
declares activity, and the Mac stays awake with a black framebuffer until the next session
asks for a frame, which then recovers it. That is acceptable but it is worth knowing that
an awake Mac with the lid shut is not necessarily a Mac with a visible screen.

## States that remain outside this

| State | Detected as | Behaviour |
| --- | --- | --- |
| Unlocked, logged in | `UNLOCKED` | works, verified |
| Locked, still logged in | `SESSION_LOCKED` | works, verified 3 November: capture and typing |
| Logged out, at the login window | `LOGIN_UNCONFIRMED` / `NOT_CONSOLE_SESSION` | refuses, returns `MAC_UNAVAILABLE` |
| Asleep | nothing runs | `womp 1` on AC allows a magic-packet wake; there is no wake-on-request path |

Still not tested, and not claimed: relock after display sleep mid-session, fast user
switching, and the login window, which the code refuses by design.

## A lid with no display attached is still a screen

This was the last open question, and it came out better than expected. With the charger
in, the monitor unplugged and the lid shut, `system_profiler` listed exactly one display:
the built-in Retina panel at 2560x1664, `Online: Yes`. `session-state` returned
`UNLOCKED`, `pmset -g` returned `SleepDisabled 1`, and a capture through the driver
returned a full 269,908-byte frame of the live desktop, rendered while the panel itself
was shut. Plain typing and clicking therefore work in this state too, because input never
depended on a visible panel.

So a laptop with nothing plugged in and the lid closed remains fully usable, and no dummy
display adapter is needed. The earlier black frame was a different cause: the display had
been turned off after the lock screen went idle, not removed.

## Losing power is the one thing that puts it to sleep

While the charger was out during this test the Mac slept, which the machine's own log
shows rather than my reasoning:

```
2026-11-03 15:44:16 Sleep  Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 596 secs
2026-11-03 15:54:57 Sleep  Entering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 68 secs
```

The helper had logged `10:13:42Z normal sleep restored (on-battery)` at 15:43:42, and the
clamshell sleep followed 34 seconds later. Both directions of the battery transition are
now verified on live hardware, which had been listed as unverified since 2325: pulling
power gives up the hold, plugging back in (`10:30:06Z lid-closed sleep disabled`) takes it
again. The cost is real and worth stating plainly: unplugging a closed Mac makes it sleep
within about half a minute, remote control goes down with it, and `womp` is 0 on battery,
so nothing short of physical input brings it back.

## The ceiling nobody can code around

FileVault is on and there is no auto-login. After a restart the Mac stops at the pre-boot
login screen, where no part of this product runs and none can. Any reboot or power loss
therefore means the machine is unreachable until someone is physically in front of it.
Turning FileVault off is the only thing that changes this, and it is a real security cost,
so it stays a decision for the owner rather than a default.
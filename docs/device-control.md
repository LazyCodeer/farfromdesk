# Device control from the owner's chat

The owner can ask the brain to do one thing on the Mac itself, from the same chat
they use for coding sessions:

    open Comet
    what is on my screen
    click Compose in Comet
    type standup notes in Notes
    press escape

## Why the brain answers it instead of dispatching it

Measured on 3 Nov 2026: "open TextEdit and type hello" reached the brain, became a
coding task, was queued to the Codex session, and stopped there. The session cannot
open an app on this Mac, so the request was silently lost and the owner got nothing
back. A device request is now never a task, and `src/router.ts` still holds no Mac
control reference: the brain runs it through `src/brain-device.ts`.

The reply is written from what the driver reported. The model chooses the action; it
never states that something worked.

## Vocabulary

One action per message, addressed by name, validated by `DevicePlan`:

| Action | Needs | Driver call |
| --- | --- | --- |
| `open_app` | `app` | `launch_app`, background, never foregrounds |
| `read_window` | `app`, optional `window` | `get_window_state`, markdown tree |
| `click` | `app`, plus `name` or `role` | `run_steps` |
| `type` | `app`, plus `text` and `name`/`role` | `run_steps` |
| `press_key` | `key` from return, tab, escape, up, down, left, right | `run_steps` |

The model is given `devices`: the apps that have a window open right now, with window
titles. It is fetched only when `allowDevice` is on, so a brain without it never
starts the desktop driver.

## Safety rules, and why each exists

- **Background delivery is fixed, not chosen.** `delivery_mode: "background"` means
  the owner keeps working and the pointer does not move. A step that a toolkit refuses
  to take in the background is reported as refused rather than quietly foregrounded:
  `foreground_fallback` stays off.
- **Sensitive apps are refused by name as well as bundle id.** The owner says "System
  Settings", not `com.apple.systempreferences`, so matching only the bundle id would
  have let the exclusion be walked past by the obvious phrasing.
- **`press_key` has no modifier, and takes six keys.** No key combination means no
  `cmd+q`, no `cmd+space`, no terminal invocation.
- **Text is length bounded and rejects control characters.** One field cannot carry a
  second command.
- **An omitted field is a question.** `devicePlanIssue` asks which app, which key or
  what text, rather than sending a half-formed plan to the driver.
- **A missing macOS grant is named exactly.** Accessibility and Screen Recording
  belong to the desktop driver, which is a different TCC subject from the Remote
  control helper. `deviceRefusal` says which one to change.

## Two defects the first live test found

Both came from asking a real installed build to act, and both now have a regression
test in `test/desktop-assist.test.ts`.

- "what is in Comet right now" was answered with Comet's menu bar. Comet holds four
  windows and three have no title, and the resolver took the first one. A titled window
  is now preferred, because that is the one the owner means.
- "press escape" was refused by the driver: `run_steps rejected before running
  anything: observe: pid and window_id are required (no step names a window to
  inherit)`. Background delivery acts on a window, so an action batch now names the
  resolved window, and `press_key` requires an app like every other action rather than
  accepting a bare key.
- "what is in Comet right now" then answered "Comet is not in the list of open apps I
  can see right now", twice, while `list_windows` reported twelve Comet windows. The
  target list and the resolver both read `get_accessibility_tree`, which lists on-screen
  windows only, so a minimized or other-Space window made a running app look absent.
  Both now take window titles from `list_windows`, which also lists those. A second
  transient failure in the same span, "Meta could not read that message", was the Meta
  API and not this code: an immediate retry succeeded.

## What the second and third live tests found

Reading a real browser window eight times on the owner's Mac produced one window read per
round, each finding something the previous round had not:

    - Apple; Comet; File; Edit; View; Assistant; History; Bookmarks; Profiles; Tab; Window; Help
    - Private Email - business email hosting by Namecheap   (the title again, icon and all)
    - Deployment name / Deployment name" = "claude-fable-5-1"
    - 1:13 / PM / (Raise hand (ctrl + ⌘ + h))
    - 1:05 PM

so `summarizeTree` now drops the menu bar and everything under a toolbar, drops a heading
that repeats the window title, reads a field as `label: value` once, and leaves out clocks,
counters, keyboard shortcuts and labels shorter than three characters. A field that later
arrives with its value drops the bare label.

A refused click was also read back as "I could not do that: nothing there matched that
name", which never says what was looked for. `refusalLine` takes the plan as well as the
driver text, so the sentence names the owner's own target, on both the thrown and the
reported path.

One behaviour is deliberately left as it is: the driver connection dropped twice during
these tests, and the owner got "I lost the connection to the desktop helper just then, so I
cannot say what happened. Check the app, then ask me again." The next action reconnected
and succeeded, and a write action is never replayed automatically, so the honest report
costs one message and cannot double-execute.

## The device router runs before the contract review

Found by database forensics, not by reading the code: the failing message never reached the
brain at all. The `task_contracts` row for "press escape in Comet" had no matching
`brain_tasks` row and no `request_events`, while "open Comet" and "press escape" did.
`receiveOnce` runs the task-contract preflight before `brain.handle`, and that preflight is
a second, narrower classifier whose prompt asks only "is this unclear coding work?" with no
device concept, so it intercepted Mac phrasing first.

So now the router asks `brain.claimsDevice` first and skips the preflight when the
deterministic router will claim the message. The branch is deliberately in this order:

1. a cheap shape test, so only device-shaped messages consult the driver at all,
2. the real target list, cached, so "open the PR" is still not claimed,
3. only then the preflight, which keeps its guard on everything else.

## Obvious commands do not ask the model

`detectDevicePlan` runs before inference, for an explicit device verb on an app that is
open right now, and when it fires the model is never consulted. This exists because the
measured failure was the model's intent choice, not the execution path: "open Comet" was
classified correctly while "press escape in Comet" was classified as coding work and
turned into a task-contract review, which is a Meta call and an owner-facing question for
what should have been one keypress.

It is deliberately conservative, because a false positive would hijack real coding work.
The app must match the live target list exactly after filler words are removed, so

    "open Comet"                  detected
    "press escape in Comet"       detected
    "click Compose in Comet"      detected
    "type hello there in Notes"   detected
    "open the PR"                 not detected, the model still decides
    "fix the failing tests in Comet"  not detected
    "open Notes" with no Notes window  not detected
    "press escape" with no app    not detected, a background key has nowhere to land

Everything it does not claim still goes to the model, so the device intent in the schema
remains the fallback rather than the only route.

## Who acts on the Mac follows the owner's selection

There is no second setting. `/brain` already persists `{kind:'brain'}` and
`/codex` or `/claude` already persist `{kind:'session',...}` on
`owner-target:<destination>`, and `brainSelected(router)` already reads it. So:

- `/brain` selected: the brain is told `deviceControl: "brain"`, receives the target
  list, may use the device intent, and executes it.
- `/codex` or `/claude` selected: the brain is told `deviceControl: "session"`, is not
  given the target list, and must use `task`, so the chosen session handles it through
  the desktop tools it already has. The desktop driver is never started, because only a
  device-capable selection reads the targets.
- A device intent that arrives while a session is selected is refused with the way out
  (`/brain`), not dispatched. Belt and braces: the prompt already prevents it.

The first attempt at this used an `allowDevice` flag on the brain policy. That was
wrong twice over: it needed a Settings control that did not exist yet, so the feature
would have shipped unreachable, and the policy schema is strict with a fall back to
`DEFAULT_BRAIN` (brain disabled), so writing the new key while an older build was
installed would have silently turned the brain off. Verified, not assumed:

    old build REJECTS the new config: unrecognized_keys: ["allowDevice"]
    and brainPolicy() catches that and returns DEFAULT_BRAIN, whose enabled is: false

The macOS grants themselves come first. Settings, Remote control shows four rows;
the driver needs its two, and `cua-driver permissions status` reads back the truth:

    Accessibility:    granted
    Screen Recording: granted

## What the owner receives back

Facts are written where the action happens, and the owner's layout is applied once, at the
single point every brain answer passes through (`store.outputBrain` calls `ownerReply` in
`src/brain-reply.ts`). A producer states what happened; it does not decide how a message
looks.

Measured live, before that split, four shapes reached the chat:

    Pressed escape in Comet.

    full read (no usable earlier read of this window to diff against)

    I read Comet (Private Email - business email hosting by Namecheap).

    Apple; Comet; File; Edit; View; Assistant; History; Bookmarks; Profiles; Tab; Window; Help

    I could not do that on your Mac: DESKTOP_NATIVE_REFUSED: [{"type":"text","text":"run_steps rejected ..."}]

So the rules are:

- A short confirmation stays one line. "Opened Comet." needs no heading and no bullets.
- Anything with more than one fact is a short first line and then a list, one item per
  line, capped at eight for a window read and ten for a dump.
- The driver's bookkeeping lines are dropped, not rewritten. A reply that is nothing but
  bookkeeping keeps its own words, because an empty answer would fail the reply receipt's
  identity check and hide that something did happen.
- A semicolon run of four or more parts is a list its writer forgot to break.
- The driver's own text never goes to the owner. `refusalText` keeps the sentence out of
  the MCP content envelope, `plainCause` drops machine markers, and the raw message is
  replaced by a diagnostic code (`driver_unavailable`, `driver_refused`, `driver_busy`,
  `target_unavailable`) recorded as a `device_action` event. Request events exclude driver
  and provider text by design, so the owner's reason and the log's reason are deliberately
  two different strings.
- Window chrome is not content. The menu bar and everything under a toolbar are dropped:
  on a browser window they were the entire answer to "what is in Comet right now".
- Long dashes, control characters and bidi overrides are removed before the message is
  queued. The formatter is idempotent, since the receipt hashes the text.

## Live test

    1. Settings, Remote control: allow Accessibility and Screen Recording.
    2. Send /brain, so the brain is the selected platform.
    3. Send "open Comet" and expect "Opened Comet."
    4. Send "what is on my screen" and expect the page's labels, one per line, without
       the menu bar and without any "full read" or "no change since" line.
    5. Send "press escape".
    6. Send /codex and repeat step 3: the session gets it, not the brain.

## Deliberately not included

- A multi-step plan. One action per message; a failure is reported, never retried.
- Any new Settings control. The selection the owner already has is the gate.
- Windows or Linux. `desktop-control.ts` is macOS only.
- Recording, cursor control and the driver's browser and CDP tools. They stay on the
  master-session tool surface where they already were.
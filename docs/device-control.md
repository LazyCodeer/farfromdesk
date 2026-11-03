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

## Live test

    1. Settings, Remote control: allow Accessibility and Screen Recording.
    2. Send /brain, so the brain is the selected platform.
    3. Send "open Comet" and expect "Opened Comet."
    4. Send "what is on my screen" and expect the window's labels.
    5. Send "press escape".
    6. Send /codex and repeat step 3: the session gets it, not the brain.

## Deliberately not included

- A multi-step plan. One action per message; a failure is reported, never retried.
- Any new Settings control. The selection the owner already has is the gate.
- Windows or Linux. `desktop-control.ts` is macOS only.
- Recording, cursor control and the driver's browser and CDP tools. They stay on the
  master-session tool surface where they already were.
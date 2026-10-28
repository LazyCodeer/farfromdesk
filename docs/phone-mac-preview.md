# Phone to Mac local preview

This preview is a selected-window viewer with owner-operated clicks and text input.
It is not smooth desktop video, full keyboard/drag control, or Windows control.
The separate LiveKit development trial remains unchanged.

## Included

The desktop app opens Phone access from Remote Desktop. Set a separate password,
check Accessibility and Screen Recording, choose an open app/window and a local
network address, and press Start. Open the displayed HTTPS address on a phone on
the same network. The app shows the temporary certificate's SHA-256 fingerprint.
Certificate acceptance is a manual owner step; the app neither changes a trust
store nor grants native permissions. If the phone cannot show/verify the
certificate, that browser is not a verified test route. No public relay is used.

The listener binds only the selected private IPv4 address on a separate random
port. It does not expose the bridge admin API, session credentials, messaging,
filesystem access, or AI model routes. Password verification uses salted scrypt,
global failed-login throttling, and a Secure/HttpOnly/SameSite cookie. Reconnecting
invalidates the previous phone. Stop closes the listener and aborts native work.

Window captures and input reuse the native owner-view implementation. Negative
desktop coordinates are converted through the native capture identity. Input
requires a frame under five seconds old and a unique action ID. Text requires an
observed nonsecure field. A new image after input lets the owner independently
check the result. An uncertain native action ends the session and is not replayed.

The page can be closed on the Mac without stopping the backend-owned preview.
A lost phone heartbeat, locked Mac, lost permission or unavailable window revokes
the phone session. The watchdog checks every two seconds; every frame and action
also checks readiness. Stop does not undo input already delivered. A native call
already in flight may finish before cancellation is observed.

## Current limits and release gates

- Same-network IPv4 only. No internet relay, VPN discovery or Windows host.
- The temporary self-signed certificate expires after one day and changes on each
  Start. This is a local test setup, not the final public phone onboarding.
- No arbitrary screen/whole-desktop selection. Protected or incompletely exposed
  windows can be refused. Scrolling, drag, key combinations and secure fields are
  not exposed by this preview.
- Images are refreshed on demand and after actions, not continuously streamed.
- No five-minute session expiry; the inherited 500-action safety cap still ends
  a connection. Restart from the Mac to begin another session.
- Actual phone-browser certificate handling and native app permission attribution
  must pass on the owner's devices before claiming end-to-end phone control.
- This patch is local and uncommitted until the review/release step. Existing
  public downloads are not updated by building this test app.

## Reproduce the local build

Use Xcode and the existing Flutter SDK, with build/cache directories on Personal:

```sh
rtk proxy bash script/build_and_run.sh --phone-preview \
  --output /Volumes/Personal/Developer/FarFromDesk/Builds/phone-preview-20261028 \
  --speech-root /Volumes/Personal/Developer/FarFromDesk/Builds/release-0.8.0-prep/source/build/speech-runtime \
  --launch
```

The script refuses to overwrite an existing preview app. It creates
`FarFromDesk Phone Test.app`, bundle ID
`com.codecylabs.farfromdesk.phonepreview.local`, with separate synthetic state and
port 49012. The production app, existing local app and saved connections are not
replaced. A source hash manifest records uncommitted inputs. The native helper is
compiled under the local-test identifier; its actual permission result must be
checked after launch rather than inferred from an older app's grants.

## Combined release audit, 28 October 2026

Base is main after merged PR 7, `025685f`. GitHub reports v0.9.0 already published.

| Feature | In this source | Verification / remaining work |
| --- | --- | --- |
| Mac existing-tab browser access | Yes | Adapter tests; app-specific Automation/JavaScript consent still applies. No Windows adapter. |
| Brain, memory and collaboration | Yes | Backend and Flutter regressions; real owner conversation trial still needed. Built-in prompt is read-only; memory/preferences are editable. |
| Meta, Deepgram and AssemblyAI voice | Yes | Provider tests; no real audio or paid model call made for this build. |
| Windows in-app updater | Yes, merged PR 7 | Prior Windows CI verified v0.8.0 replacement/state preservation; this Mac patch does not implement Windows remote control. |
| Mac structural and screenshot controls | Yes | Existing regression coverage; new packaged identity needs native permission check. |
| Phone to Mac | New local preview | TLS/auth/action tests use synthetic backend; actual native and phone tests remain gates. |

Do not label every row as live-tested merely because a combined build succeeds.

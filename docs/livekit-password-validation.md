# LiveKit and password access, local validation

Owner requirement: configure a password in FarFromDesk Settings once, keep the Mac
available while awake/unlocked, open the viewer and enter that password whenever
needed, with no fixed connected-session duration limit. Native consent stays in
macOS; no user-facing Terminal setup. This supersedes the five-minute local
prototype interaction, but does not authorize lock bypass, public deployment or
unattended agent control.

## Implemented in source, not installed

- `desktop/lib/remote_desktop.dart`: in-app password/confirmation, availability,
  Stop, LiveKit screen/window picker and local rendering. Linked from Mac control.
  Password fields are cleared after successful save; no password is displayed in
  logs or persisted as plaintext. No transport means Start remains disabled.
- `src/remote-desktop/access.ts`: salted scrypt (N=32768,r=8,p=1), one active
  connection, global failure throttling, no fixed active-session timeout,
  revocation on Stop/runtime unavailability/password change. Availability can be
  saved; a restarted service still requires fresh readiness and password auth.
- App-only `/api/remote-desktop` settings endpoint; session/agent bindings cannot
  administer it. Stored values are the verifier and availability preference.
- `src/remote-desktop/livekit.ts`: short-lived scoped join tokens. Viewer cannot
  publish video or send data/control. Established media connections are distinct
  from token expiry. Non-loopback configurations require WSS.
- `src/remote-desktop/service.ts`: app-facing coordinator, graceful suspend vs
  explicit Stop, publisher/viewer token issuing. No transport is configured by
  default, and no phone-facing listener is mounted on the bridge admin port.

Versions: LiveKit server v1.13.11, source commit
385aa40f9292fe1db8caad87301e4b285b7c198a; livekit_client Flutter 2.13.2;
flutter_webrtc 1.6.3; livekit-server-sdk 2.19.2; JS livekit-client 2.15.6.
Latest JS 2.23.0 pulled a dependency requiring Node >=22.22; the current runtime
is 22.20, so the compatible JS release was pinned and tested instead. npm audit
reported zero known vulnerabilities at installation, not a security certification.
Server built from official tagged source because the current release had no
macOS binary and go install could not consume its replace directives.

## Actual evidence

- TypeScript build passed; 18 focused tests passed (six new password/token tests
  plus twelve owner-view regressions).
- Flutter analyze on the affected application files passed.
- Flutter widget test passed: in-app password setting, clearing saved input,
  disabled capture without a configured transport.
- A real browser joined a locally compiled LiveKit server through the real JS SDK.
  Wrong password was rejected, a synthetic canvas video was published, receiver
  decoded at least 20 frames, and deleting the room disconnected the receiver.
  This did not capture the desktop, camera or microphone.
- `script/livekit_local_trial.mjs --local-synthetic-test --endurance` adds a
  330-second connected-video check beyond the former five-minute limit.
  The real browser remained connected for 330 seconds, after initial video decoding; Stop then disconnected the receiver. Final measured result lives in `docs/evidence/livekit/transport.json`.
  The harness's own 15-minute process cleanup is test-only, not a product cap.
- Seven-day advance in the password unit test proves absence of a policy timer
  only; it is not a seven-day network soak test.

The native build was attempted and failed with Flutter's exact message:
`Xcode not installed; this is necessary for iOS and macOS development.`
Only CommandLineTools was selected and no Xcode app was found by Spotlight.
No developer-tool settings were changed. Full Xcode is required to compile the
Flutter macOS plugin integration and run a correctly identified signed test app.

## Remaining before requested workflow can ship

1. Build a distinct native test app after full Xcode is available; verify native
   capture, SDK permissions and source selection with the real responsible app.
2. Move publisher lifetime out of the settings widget into an app-owned controller.
   Current development widget stops when its page is disposed. It is not the final
   always-available background experience.
3. Wire the native lock/sleep/permission monitor to suspend/revoke media. Unit tests
   simulate these signals; the LiveKit UI does not yet receive real OS transitions.
4. Build a dedicated authenticated viewer/session service, password-entry screen,
   device association and Telegram launch. The local test has fixture credentials;
   it is not a password-protected internet endpoint for the owner's real Mac.
5. Choose hosting, HTTPS domain and relay/TURN policy. No hosting or cloud account
   was created, purchased or deployed. Do not expose the existing admin bridge.
6. Add safe streamed pointer/keyboard/scroll handling with frame/geometry generation,
   input deduplication and disconnect release. Video tokens deliberately cannot send
   control yet; the earlier native screenshot-control test is separate evidence.
7. Verify media/control E2EE, password-change and disconnect revocation across all
   SDKs, copied-token behavior, actual phone browsers, network recovery and a longer
   soak. WSS/WebRTC transport encryption alone is not an E2EE claim.
8. Package signed/notarized dependencies, persist device settings appropriately,
   test upgrade/rollback without breaking grants, and keep production/test identities
   separate. No current production app, native grant or bridge was replaced.

No real owner password was chosen or requested in chat. Set it only in the app
once the native build and transport are ready. No infinite-uptime guarantee: the
policy has no fixed cap, but sleep, lock, Stop, loss of permission or connectivity
must end or suspend access and show a clear status.

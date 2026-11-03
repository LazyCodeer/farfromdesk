# ffd: the Local toolkit

One entry point for the work that used to be hand-written every time: finding what
is installed, running the right tests, rendering a screen, and shipping a build.
It exists because a single Settings change cost about 100 minutes of wall clock on
3 November, of which only about 7 minutes was real compute: the rest was stale
context, two hand-written scripts, a full extra test-suite run purely to attribute
failures, a render harness rewritten from scratch, and seven sandbox approval
prompts (the Flutter SDK lives on another volume, so every `flutter` command writes
outside the workspace).

## Commands

```sh
ffd status                                  # installed version, source, what is running, next build
ffd test backend [--baseline]               # npm test, diffed against the stored baseline
ffd test backend --update-baseline          # refresh it (needs FFD_I_MEAN_IT=1)
ffd test desktop [--all | <test files...>]  # flutter analyze + tests
ffd render --list
ffd render <scenario> [--out DIR]           # one screen to a PNG, harness cleaned up after
ffd ship [--build N] [--note NAME] [--dry-run] [--no-install]
ffd rollback [bundle]                       # put a saved bundle back
ffd permissions [--app PATH] [--compare PATH]   # who holds macOS grants, and what changed
```

Paths come from `scripts/ffd.conf`; any environment variable of the same name wins.
`ffd ship` derives the build number from the installed bundle (never from the
handoff note, which goes stale), refuses to build while another `flutter build` is
running, stages and signs into `$FFD_BUILDS/<note>-<build>`, runs the packaged
smoke, then replaces the one Local app and prints its report. The report always
prints, whatever failed before it.

## Things that cost time once, so they should not again

- **`dart format` from this SDK mangles the repo.** Dart 3.13's formatter rewrote
  unrelated code in four files (`app.dart` worst), so the change had to be reverted
  and every edit re-applied by hand. Do not run the SDK formatter over existing
  files. Match the surrounding style by hand; run it only on a file you just wrote
  from scratch, if at all.
- **Flutter's cache is outside the workspace.** `flutter analyze|test|build` fails
  with `Operation not permitted` on `bin/cache` under a workspace-write sandbox,
  which reads like a broken toolchain. Widen the sandbox for those commands, or run
  the session with full access.
- **Assets decode asynchronously; a single-scenario golden captures them blank.**
  The brand mark in the rail was missing from every render until the template gave
  the real event loop a turn (`tester.runAsync` + one more pump). The earlier
  hand-written harness only looked correct because its first test warmed the image
  cache for the others. If a logo is missing from a render, this is why.
- **Do not run the backend and desktop suites at the same time.** Several backend
  tests drive 5 ms timers and wait 40 ms for the result (`receipt-honesty.test.ts` is
  one). Under a parallel `flutter test` they miss a notice and report a failure that
  disappears when the file is run alone. `ffd test backend` now warns when a flutter
  test looks to be running, because a false "NEW FAILURE" costs more than the wait.
- **A `set -e` + `pipefail` install script dies silently.** `pgrep ... | head -2`
  kept the pipe status, so the install aborted before printing `health=` and
  `rollback=` when the backend had not started within 40 seconds, and the operator
  never saw the outcome. `ffd` does not use `set -e`; it checks each step and always
  reports, and it waits up to two minutes for the backend.
- **Two `flutter build macos` runs share one output directory.** Serialise them
  across sessions: `ffd ship` refuses to start while another build is visible.
- **Build numbers race.** Another session may install between your build and your
  install. Derive the number from the installed bundle at build time, and re-read
  it immediately before installing.
- **A Local backend can wedge** (accepts TCP, never answers, `/health` 000). `ffd
  status` prints the health code, and `ffd ship` escalates to SIGKILL only for
  processes whose command line starts with the installed bundle path.
- **`lsof`/`ps` may be unavailable in the session sandbox.** `ffd` says "command not
  readable from this sandbox" rather than printing an empty column.

## Baselines

`baseline/` holds the failures that were already there, so one suite run answers
"did I break this?" instead of two. Update deliberately:

```sh
ffd test backend               # read the NEW FAILURES block
ffd test backend --update-baseline     # only after confirming every entry is not yours
```

- `backend-known-failures.txt` (14 entries on 3 November; two of them are test stubs
  that omit `desktopControl.permissionReport`)
- `desktop-known-failures.txt` (the long-standing `social_preview_test.dart` pair)
- `analyze-known-issues.txt` (pre-existing analyzer infos, which otherwise make
  `flutter analyze` exit 1 and look like a failure)

A subset test run is reported but never compared against the full-suite baseline.

## macOS grants, and why every rebuild loses them

Measured on 3 November. It corrected an earlier guess that blamed the helper binaries.

**The subject is the app, not the helper.** tccd names it itself:

```
AUTHREQ_ATTRIBUTION: attribution={responsible={identifier=com.codecylabs.farfromdesk.localtest, ...},
                                   accessing={identifier=...localtest.accessibility, ...ffd-accessibility}}
AUTHREQ_SUBJECT: subject=com.codecylabs.farfromdesk.localtest
-[TCCDAccessIdentity staticCode]: static code for: identifier com.codecylabs.farfromdesk.localtest ... at /Users/sagar/Applications/FarFromDesk Local.app
```

So the Accessibility and Screen Recording grants belong to the app bundle, and the
helper that asks for them is only the `accessing` process. An ad-hoc signature's
designated requirement is a bare cdhash (`codesign -d -r-` prints exactly that), and
the app's cdhash changes on **every** build (measured across 2355, 2356 and 2357).
That is the whole mechanism: to macOS each rebuild is a different app, with no grants.

Things that follow from that, each of which cost time to learn:

- Keeping the helper binaries stable does **not** prevent it. The helper cache in
  `build_accessibility_helper.py` is still worth having (it removes a narrower
  identity drift and makes the emitted bytes reproducible), but it is not the fix
  for this, and neither is the session-state identifier.
- The **production** app is ad-hoc signed too (`app.sessionbridge.mac`,
  `TeamIdentifier=not set`, requirement `cdhash H"4c0a8f70..."`), so every released
  update asks every user to re-approve Accessibility and Screen Recording.
- `cua-driver` is the in-repo proof of the fix: it is vendor-signed (Team ID
  `YCK386LBJ7`), so its requirement names the team rather than the bytes, and its
  grant survives every rebuild.
- A process tree that already holds the grants answers for itself. Running a
  byte-different copy of the helper from a grant-holding shell reported "allowed",
  because TCC attributes to the responsible process, not the helper. Never read one
  helper run as proof of what the app will see.

**The fix is a signing identity.** `security find-identity -v -p codesigning` reported
**0 valid identities** on this Mac on 3 November. Xcode 27.1 is installed, so a free
Apple ID plus Xcode > Settings > Accounts > Manage Certificates > Apple Development
produces one. The app's requirement then becomes `identifier + anchor apple generic +
certificate leaf[subject.OU] = TEAMID`, the stored grant keeps matching across
rebuilds, and the owner allows the two services once instead of after every install.

Until then, re-approve after each Local install (`ffd permissions` names what changed
and what to click), and clear a row that will not switch on with
`tccutil reset Accessibility com.codecylabs.farfromdesk.localtest` (and
`ScreenCapture` for the same identifier). `tccutil` cannot grant anything; only the
owner can switch it on.

### Signing with an identity (the fix)

Create the certificate once, in Xcode, with any Apple ID (a free one is enough for
Local):

> Xcode > Settings > Accounts > **+** Apple ID > select the team > Manage
> Certificates > **+** > Apple Development

Then nothing else is needed: `ffd ship` finds the identity in the keychain and signs
with it, and `ffd status` shows it. Override the choice with `FFD_SIGN_IDENTITY`, and
name it explicitly if the keychain ever holds several:

```sh
FFD_SIGN_IDENTITY="Apple Development: you@example.com (ABC123DEFG)" ffd ship
```

What it signs, and why each part matters:

- the two nested TCC subjects, `FarDesk Accessibility.app` and `session-state`, so
  their requirements name the team as well;
- the app bundle itself, which is the subject macOS actually records the grant
  against (`AUTHREQ_SUBJECT`);
- **never** `cua-driver`. It carries the vendor's signature, and re-signing it would
  replace the very requirement that keeps its desktop-control grant working. This is
  why nothing here uses `codesign --deep` on the app.

Verify it took:

```sh
ffd permissions          # the app should read "identity <TEAMID> (a rebuild keeps the grant)"
codesign -d -r- "/Users/sagar/Applications/FarFromDesk Local.app"
```

The requirement should name the team and the certificate, not a `cdhash`.

If `codesign` fails with `unable to build chain to self-signed root` and
`security find-identity -v -p codesigning` says **0 valid identities** while Xcode
happily lists the certificate, the certificate has no usable chain. That is what
happened here on 3 November:

- `security find-identity -p codesigning` (no `-v`) listed the identity, so the
  private key was present; only the chain was broken.
- The certificate's issuer was `Apple Worldwide Developer Relations Certification
  Authority, OU=G3`, while the only intermediate installed was the 2013 WWDR CA,
  which **expired on 7 February 2023**.
- Apple Root CA - G3 was already in the System Roots, so installing the missing G3
  intermediate completed the chain.

```sh
curl -sS -o /tmp/AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
openssl x509 -inform DER -in /tmp/AppleWWDRCAG3.cer -noout -subject -issuer -dates   # check before trusting
security add-certificates -k "$HOME/Library/Keychains/login.keychain-db" /tmp/AppleWWDRCAG3.cer
security find-identity -v -p codesigning                                            # now: 1 valid identity
```

That adds the certificate only. It changes no trust settings: the trust comes from
Apple's roots already in the System Roots store. The download URL above was taken
from Apple's own certificate authority page rather than guessed.

Also worth knowing: signing with a new identity makes the app a different code
identity to the keychain as well as to TCC, so a keychain-backed helper (the Local
mail helper) can ask once for access to an item created under the old signature.
"Always Allow" settles it.

Expect **one** re-approval after the first team-signed build: to macOS that build is
still a different app from the ad-hoc ones, so allow Accessibility and Screen
Recording once more. From then on, rebuilds keep the grants, which is the whole point.

The install and rollback paths deliberately do not re-sign: a copied bundle keeps its
signature, and re-signing it ad-hoc would change the requirement its grant was stored
against. They only repair a signature that the copy itself broke, and then with the
same identity.

### The desktop driver's rows are not grants (3 November 2026)

The Settings page used to show "Desktop driver access" and "Desktop driver screen
access" as if they were two more permissions the owner had to give. They are not, and
there is no way to give them. Measured, in order:

- `cua-driver permissions grant`, the vendor's documented grant path, hard-codes
  `/Applications/CuaDriver.app` and fails here with "Didn't detect the CuaDriver
  daemon: launching `/Applications/CuaDriver.app` exited Some(1)". That bundle is the
  vendor's own installer, not something this package ships.
- Asked through our embedded daemon, the driver answers with its own explanation:

  ```
  "attribution": "host", "embedded": true,
  "host_bundle_id": "com.codecylabs.farfromdesk.localtest.accessibility",
  "note": "Embedded mode: these booleans reflect the HOST app's TCC grant (the driver
           is a child in the host's responsibility chain). No separate driver grant
           exists or is needed. If a permission is NOT granted, the host app must
           request it - the driver never raises its own prompt."
  ```
- Its `accessibility` boolean is therefore not trustworthy: with every grant in place
  it reported `false` while `get_window_state` through the same driver returned a
  window's accessibility tree (`element_count: 13`). A preflight that can say no while
  the work succeeds must never be the gate.

So the two rows are now capability-tested: `capabilityProbe()` makes one harmless read
(`list_windows`) through the driver, cached for 15 s and forced by the row's Test
button, and the row says Allowed when that read works. `requireDesktopPermission()`
asks the preflight first and only refuses when a live read also fails, quoting the
driver's own reason. Deciding this by preflight alone had desktop control refusing
work that succeeded.

macOS 27 adds a third layer on top of the two toggles: a **"Device Control and Data
Access"** prompt that names **FarFromDesk Local** (not the driver, and not the
helper). If it is on screen waiting, answer it, or the grant never settles.

### What build_accessibility_helper.py does about the helper side

It caches each helper under `build/native-helper-cache/`, keyed on the Swift source
bytes, the swiftc and SDK versions and the exact compile arguments, and reuses an
unchanged helper instead of recompiling and re-signing it. Recompiling unchanged
source is reproducible (verified: the current source reproduces the installed
helper's cdhash exactly, and the output does not depend on the output directory), and
`session-state` now carries an explicit
`--identifier com.codecylabs.farfromdesk.localtest.session-state` instead of a
linker-derived UUID. `--no-cache` forces a clean compile for a release.

## Renders

`ffd render` copies `templates/render_scenarios.dart` into
`desktop/test/zz_ffd_render_test.dart`, renders one scenario at the owner's window
size (1156x814), copies the PNG out, and deletes the harness and its goldens even
if the run fails. The repo keeps no goldens on purpose: they break on every
unrelated UI change and, with another session in the same tree, they fail for
reasons that are not yours.

Scenarios are declared in that template. Add a case there and every command picks
it up. Two limits: button labels always render as blocks (`flutter_test` resolves
`ButtonStyle` text through a path that ignores the loaded family), so assert a
label with `find.text` in a widget test; and the render proves layout, never
liveness, so confirm a shipped build with a real capture.
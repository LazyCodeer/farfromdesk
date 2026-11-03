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

## macOS grants, and why a rebuild loses them

Measured on 3 November from the installed bundles with `codesign`:

- Every grant-holding binary in the Local app is **ad-hoc signed**, and an ad-hoc
  signature's designated requirement is a bare `cdhash H"…"` (`codesign -d -r-`
  prints exactly that). macOS stores the Accessibility and Screen Recording grants
  against that requirement, so a grant belongs to those exact bytes: change one byte
  and macOS sees a different app with no grants.
- `script/prepare_desktop_backend.mjs`, through `script/build_accessibility_helper.py`,
  **recompiles both Swift helpers on every full packaging run**: `FarFromDesk
  Accessibility.app` (`com.codecylabs.farfromdesk.localtest.accessibility`) and
  `session-state`, which serves the phone remote. `session-state` is not even given
  an `--identifier`, so the linker derives one from the binary's UUID and it changes
  with every build (`session-state-55554944…`), so both the identifier and the cdhash
  move.
- `cua-driver` is the exception. It keeps its vendor signature (Team ID
  `YCK386LBJ7`), so its desktop-control grants survive rebuilds while the vendored
  binary is unchanged.
- **An ordinary `ffd ship` install does not recompile helpers.** It copies the
  installed `Resources/backend` forward and overlays only `dist/` and `skills/`.
  Measured across 2355, 2356 and 2357: helper, driver and session-state cdhashes were
  identical, so those installs dropped nothing. The loss comes from builds that
  re-run the native packaging step (the release pipeline, or a Local build that calls
  `npm run desktop:backend`).

Three fixes, cheapest first:

1. **Reuse an unchanged helper.** Key a cache on the Swift source hash plus the
   swiftc and SDK versions; on a hit, copy the previously built, already granted
   binary instead of recompiling and re-signing it. Recompiling unchanged source is
   reproducible here (verified: the current source reproduces the installed helper's
   cdhash exactly), and both helper sources last changed on 27-28 October, so the
   grant would then survive essentially every rebuild.
2. **Give `session-state` a real identifier**
   (`--identifier com.codecylabs.farfromdesk.localtest.session-state`) so its TCC
   client is nameable and `tccutil reset` has a stable target.
3. **Sign with an identity.** `security find-identity -v -p codesigning` reported
   **0 valid identities** on this Mac. An Apple Development certificate (a free Apple
   ID through Xcode > Settings > Accounts > Manage Certificates) makes the
   requirement `identifier + anchor apple generic + certificate leaf[subject.OU] =
   TEAMID`, which does not depend on the bytes. That is the only fix which survives a
   real change to the helper source.

Until one of these lands: `ffd permissions` prints each grant holder with its
identifier, cdhash and whether its identity is byte-based or team-based, and diffs it
against another bundle (default: the newest stage). `ffd ship` prints that impact for
every build and records it in the stage's `RESULTS.md`. When System Settings shows a
row that will not switch on, clear the dead entry first:

```sh
tccutil reset Accessibility com.codecylabs.farfromdesk.localtest.accessibility
tccutil reset ScreenCapture com.codecylabs.farfromdesk.localtest.accessibility
```

`tccutil reset` only removes. Nothing can grant: macOS has no API for that, so the
owner still has to switch the row on. Budget one re-grant after any build that
changes a helper, and none after a build that does not.

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
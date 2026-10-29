# Testing FarFromDesk

## Default checks

```sh
npm ci
npm run check
./script/run-tests.sh all
./script/test_macos.sh
```

The backend suite covers routing, exact session binding, catalog pagination, discovery bounds, lifecycle/recovery, approvals, prepared artifacts, media errors, native adapter contracts and bounded file reads. Native tests cover status decoding, group caching, stale response cancellation, setup state and the app picker.

The safest backend test entry point is `./script/run-tests.sh all` on macOS and
Linux, or `script\run-tests.cmd all` on Windows. It clears inherited Node
startup hooks before launching Node. Use `portable` instead of `all` for the
portable suite. Both wrappers then start the tests with a new private temporary
state directory, scratch directory and separate user, coordinator, Codex and
Claude homes. The runner removes that directory when it exits. The child receives only a narrow
allowlist of platform and explicitly opted-in test variables. It does not
inherit an existing `WSB_STATE_DIR`, bridge port, helper paths, service URLs,
credential/config locations or `NODE_OPTIONS`. `PATH` and the optional
`WSB_AUDIO_TEST_*` fixture paths are inherited intentionally, so use trusted
values. This environment filtering is not a guarantee that no secret reaches a
test through files, allowed values or an explicitly replaced child environment.
On POSIX cancellation the runner also stops its own test
process group; detached descendants and forcible termination cannot be cleaned
up reliably. On Windows cancellation stops the direct runner process only.
Unmocked Node `fetch` calls
to non-loopback destinations are blocked, and unmocked loopback redirects are
not followed. Tests can inject fakes and use a loopback server. This is not an
OS sandbox: raw sockets, other HTTP clients and
subprocesses that replace their environment can still access the network.

Before creating temporary state, the runner resolves the temporary base and the
configured and default app-state and coordinator paths (including symlink aliases). It refuses
to run if the temporary base is inside any of those directories. Resolving these
paths uses filesystem metadata, not their contents. If a sandbox or permissions
prevent resolving an existing path, the runner fails closed. Choose a separate
writable temporary directory and use a sandbox that permits the necessary path
metadata while denying access to app-state and coordinator contents.

`npm test` and `npm run test:portable` also use the isolated test runner, but
the npm process itself starts before that runner can clear `NODE_OPTIONS`.
Therefore, a pre-existing Node startup hook may already execute in npm;
`NODE_PATH`, `NODE_EXTRA_CA_CERTS` and `NODE_V8_COVERAGE` can likewise affect
it before the runner starts. Clear or trust these variables before invoking npm,
including for `npm ci` and `npm run check`. The shell or batch wrapper clears
them before starting Node for tests.

For focused tests, use the same isolation instead of invoking Node or tsx
directly:

```sh
./script/run-tests.sh files test/meta-brain.test.ts
```

On Windows, use `script\run-tests.cmd files test\meta-brain.test.ts`.

Direct `node --test` and `tsx --test` commands bypass this runner. Set a fresh
private `WSB_STATE_DIR` before Node starts and block external networking when
using them. Do not point test processes at an installed application state.

## Opt-in local speech

Build the speech runtime first. These tests use the checked-in synthetic audio fixture, silence and corrupt bytes; they do not record a microphone or message a chat.

```sh
WSB_AUDIO_TEST_FFMPEG="$PWD/build/speech-runtime/ffmpeg" \
WSB_AUDIO_TEST_WHISPER="$PWD/build/speech-runtime/whisper-cli" \
WSB_AUDIO_TEST_MODEL="$PWD/build/speech-runtime/ggml-base.bin" ./script/run-tests.sh all
```

## Render checks

```sh
WSB_RENDER_PREVIEWS="$PWD/.local/previews" ./script/test_macos.sh
```

Render previews use sample data. A successful render does not establish full live mouse/keyboard behavior. Inspect narrow layouts, long names, disabled controls, empty states, error states and contrast.

## Live verification

Use a dedicated owner-selected session and harmless requests. Check authenticated receipt, correct destination and exact native session, native acceptance, agent action, and correlated final reply. Repeat after a relevant app/runtime upgrade. A generated transcript alone does not prove action execution.

Exercise offline/reconnect, duplicate inbound events, unavailable apps, expired approvals, ambiguous submission, and failed document/media handling. Do not trigger destructive actions to test recovery. Record local versus real-phone evidence separately; never attach private recordings or state databases.

## CI scope

The Checks workflow runs backend and native fixtures without live accounts. The Mac preview release workflow additionally builds bundled speech tools and runs synthetic voice tests on both architectures. Live WhatsApp tests remain separate. CI passing is not a public-release certification. Publication guard tests use synthetic files and never upload a release.

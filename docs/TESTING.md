# Testing FarFromDesk

## Default checks

```sh
npm ci
npm run check
npm test
./script/test_macos.sh
```

The backend suite covers routing, exact session binding, catalog pagination, discovery bounds, lifecycle/recovery, approvals, prepared artifacts, media errors, native adapter contracts and bounded file reads. Native tests cover status decoding, group caching, stale response cancellation, setup state and the app picker.

`npm test` and `npm run test:portable` start Node with a new private temporary
state directory and separate user, coordinator, Codex and Claude homes. They remove
that directory when the test runner exits. An existing `WSB_STATE_DIR`, bridge
port, helper paths, common credential-named variables or `NODE_OPTIONS` is not inherited by
the test runner. On POSIX cancellation the runner also stops its own test
process group; detached descendants and forcible termination cannot be cleaned
up reliably. On Windows cancellation stops the direct runner process only.
Unmocked Node `fetch` calls
to non-loopback destinations are blocked, and unmocked loopback redirects are
not followed. Tests can inject fakes and use a loopback server. This is not an
OS sandbox: raw sockets, other HTTP clients and
subprocesses that replace their environment can still access the network.

For focused tests, use the same isolation instead of invoking Node or tsx
directly:

```sh
npm run test:file -- test/meta-brain.test.ts
```

Direct `node --test` and `tsx --test` commands bypass this runner. Set a fresh
private `WSB_STATE_DIR` before Node starts and block external networking when
using them. Do not point test processes at an installed application state.

## Opt-in local speech

Build the speech runtime first. These tests use the checked-in synthetic audio fixture, silence and corrupt bytes; they do not record a microphone or message a chat.

```sh
WSB_AUDIO_TEST_FFMPEG="$PWD/build/speech-runtime/ffmpeg" \
WSB_AUDIO_TEST_WHISPER="$PWD/build/speech-runtime/whisper-cli" \
WSB_AUDIO_TEST_MODEL="$PWD/build/speech-runtime/ggml-base.bin" npm test
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

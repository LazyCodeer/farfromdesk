# Testing Sidekick

## Default checks

```sh
npm ci
npm run check
npm test
./script/test_macos.sh
```

The backend suite covers routing, exact session binding, catalog pagination, discovery bounds, lifecycle/recovery, approvals, prepared artifacts, media errors, native adapter contracts and bounded file reads. Native tests cover status decoding, group caching, stale response cancellation, setup state and the app picker.

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

The GitHub workflow runs backend and native fixture tests without signing credentials, private app accounts, live WhatsApp, or speech downloads. Opt-in speech and live checks are skipped there. CI passing is not a public-release certification. The explicit release script runs checks locally before building a preview archive.

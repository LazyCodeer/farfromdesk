# WhatsApp native document limit audit — 25 October 2026

The former 512 MiB outgoing cap was a provisional application resource bound chosen to fit the then-current build packages. It was not a WhatsApp limit and did not satisfy the corrected requirement. It is replaced by the observed ordinary WhatsApp Web document ceiling: **2,097,152,000 bytes (2000 × 1024 × 1024)**.

## Authoritative evidence and exact units

- [WhatsApp's official announcement](https://blog.whatsapp.com/reactions-2gb-file-sharing-512-groups) says files up to **2 GB**, increased from 100 MB. That marketing page alone does not specify the exact byte count.
- The current anonymous [official WhatsApp Web client](https://web.whatsapp.com/) loads `WAWebServerPropConstants`, whose `MAX_FILE_SIZE_BYTES` is `2e3 * 1024 * 1024`, while its older `DEFAULT_MAX_FILE_SIZE_BYTES` is `100 * 1024 * 1024`.
- `WAWebMediaGatingUtils.getUploadLimit` uses **MAX_FILE_SIZE_BYTES** for ordinary documents. Its vCard-as-document branch is separate. `WAWebProcessRawMedia` rejects ordinary files when their size is greater than that selected limit, so equality is accepted by the client gate.
- A different `2147483648` constant in raw-media processing applies to the Windows video transcoder. It is not the ordinary document limit and was not used to set this implementation's ceiling.

Official CDN evidence retrieved from the Web page (URLs are versioned and may expire):

[Server constants bundle](https://static.whatsapp.net/rsrc.php/v4iaEf4/yY/l/en_GB-j/7cL50Ab318nDMjRMEF9O2eBA7IDq0QmCS6rNDBe_wQTJtI1V2mxrKYYJwUvmavsS0GOmex1l3EZC6bQS1MP9SD0GBWs7rxQFpzJ9wOG39rwPJYRMFMwBgdZyBDkk39f6FpLI3xvNBvuh3gkJ4JUsPT2RvL6gZfHQw5zR7.js), SHA-256 `1ef1ac324436d025105f2f38357625d5487aadae823553ab56b8d539a9778da5`.

[Media gating bundle](https://static.whatsapp.net/rsrc.php/v4i-zP4/y6/l/en_GB-j/prua9yJpZFk.js), SHA-256 `09e6ec22280d5bd71768e609260e7146e504a045931a5903998410318c951792`.

These establish the observed client gate, not a contractual guarantee for every linked account, server, media type, future version or real transfer.

## Different transports and types

| Surface | Evidence and implementation |
|---|---|
| Ordinary consumer documents | Official Web client: 2,097,152,000 bytes. Applied to incoming and outgoing streamed documents. |
| Consumer image/audio/video messages | Official Web gating uses separate runtime AB properties: `default_media_limit_mb`, `default_audio_limit_mb`, `default_video_limit_mb`, with MiB conversion. No single live account's effective values were queried. Incoming images/audio already accepted by WhatsApp are streamed without lower arbitrary app byte gates; documents' ceiling is not presented as their media limit. Video messages remain an unsupported feature. |
| Meta Business Cloud API | [Official media docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media) list 100 MB documents and 5 MB images. This bridge does not use that API. |
| Baileys 7.0.0-rc14 | Streaming document encryption supports filesystem/stream input. Protobuf `fileLength` is uint64; no lower document cap was found in the selected path. `refreshMediaConn` returns each host's `maxContentLengthBytes`. The uploader honors any positive reported encrypted-body ceiling and reports it if no host can accept the file. |
| Native model image inputs | Claude 5 MiB and the existing Codex adapter's 10 MiB budget affect inline model input, not receipt/storage of the file. Larger images remain local references. |
| Local voice transcription | Five-minute processing/decoded-PCM budget is retained. The compressed-input 10 MiB gate and whole-download buffer are removed. |

## Resource and transport checks

There is no 2 GiB prepared-storage quota or 100 MiB incoming quota. Resource controls are actual free space plus 128 MiB headroom, streaming/backpressure, private staging, bounded concurrency, deadlines and cleanup. A single maximum document may require its staged plaintext plus an encrypted copy and temporary incoming/forwarded copies; insufficient physical space is a real preparation failure.

The pinned Baileys `getHttpStream` passes only dispatcher/method/headers to fetch, dropping supplied signal and redirect options. Its decrypted stream also does not propagate consumer destruction to the fetched stream. Production download now uses bounded native HTTPS against the fixed WhatsApp media host, refuses redirects, propagates abort/destruction and verifies the WhatsApp HMAC using Baileys key derivation. Plaintext count/hash and session/owner checks remain mandatory before routing. Controlled local tests exercise actual AES/HMAC processing, cancellation and redirect rejection.

Legacy JSON preparation retains a small-message encoding bound; both the desktop and CLI use streaming for larger files. No file is renamed, split, disguised, uploaded elsewhere or executed to fit a limit.

## Verification boundary

Offline tests verify exact maximum/+1 checks, real Baileys encryption and generated document length/hash, loopback streaming, metadata-only SQLite storage, private incoming staging, owner/session/destination checks, cancellation, redirects, authenticated media-host ceilings and cleanup. They do not establish live WhatsApp server acceptance or phone delivery at the maximum. No maximum-size file was sent to WhatsApp during these checks.

At the initial audit, installed build 2010 used the integration owner's frozen 512 MiB source snapshot. The user subsequently authorized a local build/restart: build 2013 now includes the native-limit correction (see local-build-2013.md). The four intended release packages still need identification and exact byte/hash/type/architecture verification before direct delivery.

### Recorded results

- `npm run check`: passed.
- `npm test`: 184 tests, 182 passed, 0 failed, 2 opt-in skips (local speech smoke and full-size probe).
- `flutter analyze --no-pub`: clean. `flutter test --no-pub`: 14 passed, including a 2000 MiB sparse-file desktop reference test.
- Separate full-size probe: `FFD_LARGE_DOCUMENT_PROBE=1 npm exec -- tsx --test --test-name-pattern='2000 MiB offline' test/large-documents.test.ts` passed. Plaintext 2,097,152,000 bytes; real Baileys-encrypted upload 2,097,152,026 bytes. Outgoing preparation used raw loopback HTTP; encrypted upload used a controlled loopback server; relay was a test double. The same maximum plaintext also passed incoming streaming/staging and metadata-only storage. Incoming network/decryption was substituted in that large probe; separate transport tests exercise AES/HMAC, redirects and cancellation. Total elapsed approximately 312 seconds. RSS baseline 171,573,248 bytes, peak 196,247,552 bytes: growth **24,674,304 bytes (23.5 MiB)** on this Mac. Temporary test files were removed.
- Before the later build-2013 deployment, the authenticated live capability endpoint was checked after the integration owner's separate installation: outgoing 536,870,912 bytes, incoming documents 26,214,400 bytes, images 10,485,760 bytes and prepared quota 2,147,483,648 bytes. Those are the frozen older implementation's settings, not this correction.
- No live maximum-size WhatsApp upload, recipient receipt/opening, Windows/Linux runtime test, new four-platform release package validation, or direct build delivery was performed.

### Authorized local deployment

Local build 2013 was built, signed, smoke-tested, installed and restarted at the user’s explicit request on 25 October 2026. The live backend now reports 2,097,152,000-byte incoming/outgoing documents, no fixed artifact quota and no invented image-byte acceptance cap. WhatsApp is connected, voice is ready, and all 13 bindings, nine pending requests and background/keep-awake settings were preserved. This verifies deployment, not maximum-size live WhatsApp transfer.

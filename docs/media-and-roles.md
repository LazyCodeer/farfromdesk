# FarFromDesk media and companion roles

This describes the source implementation and its separately authorized local deployment. It does not imply that older releases have these capabilities or that maximum-size WhatsApp delivery has been validated.

## Transport and provider support

The bridge uses `@whiskeysockets/baileys` 7.0.0-rc14 consumer linked-device transport, not the Business Cloud API. Current official WhatsApp Web code sets the ordinary document ceiling to **2,097,152,000 bytes = 2000 MiB**, advertised publicly as “2 GB”. The source implements this same ceiling for incoming and outgoing documents. It does not round it to 2,000,000,000 bytes or 2 GiB. See [native-limit evidence](media-native-limits.md) for the exact official modules, URLs and hashes.

| Path | Source behavior |
|---|---|
| Incoming documents and outgoing approved files | Stream up to 2,097,152,000 bytes, retaining true filenames, MIME types and integrity checks |
| Incoming JPEG/PNG/WebP/GIF image messages | Stream files already accepted by WhatsApp's per-type runtime gate; no invented 10 MiB app acceptance limit and no claim that documents' 2 GB ceiling applies to images |
| Managed Codex image inputs | Native image when within the existing 10 MiB adapter budget; larger received images remain local references |
| Managed Claude CLI/SDK images | Native image up to 5 MiB; larger received images remain local references |
| Desktop/channel attachments | Reviewed private local references; provider permissions determine readability |
| Voice notes | Stream authenticated bytes without the former 10 MiB input cap; local transcription still has a five-minute processing budget |
| Video messages, stickers and unsupported extensions | Not implemented by this file feature; no universal 2 GB media claim |

Supported document extensions include PDF/HTML/text/source files, Office Open XML, images as documents, reviewed archives and reviewed build packages. Only approved outgoing documents are sent. There is no photo/video transcoding, automatic extraction, execution or installation.

Image input acceptance still depends on the selected provider/model and valid image content. There is no silent provider fallback or forced image conversion. File transport does not promise that a provider can parse every document or build format. Binary types are first-class files; they are never renamed to `.txt` or `.pdf` to bypass restrictions. Header checks detect common type mismatches; they are not malware scanning or full format validation.

Managed CLI paths support macOS, Windows and Linux using their existing native adapters. Desktop inbox injection is available only through the existing macOS adapter. Remote/cloud sessions without access to the same local filesystem are not supported by this reference transport. Local file references remain subject to native tool permissions. Binding checks isolate bridge delivery, not OS processes running as the same user.

## Receiving and forwarding

Send a caption with the file, quote a session's reply, or use `/to NAME caption`. Otherwise the current master (or direct-session focus when no coordinator exists) receives it. With no caption, the session is asked to acknowledge receipt and ask what to do. Captions cannot approve tools or run bridge commands other than explicit `/to` routing. File content is always untrusted data.

The bridge authenticates the linked owner's self-chat or registered owner-only group before downloading. It streams only from WhatsApp's fixed media host with redirects disabled, authenticates the encrypted stream's HMAC, verifies the advertised byte count when present and plaintext SHA-256, and checks routing and group membership again before staging. At most two image/document downloads run concurrently, with 30-second inactivity and one-hour wall deadlines; voice has its existing two-job concurrency bound. Duplicate WhatsApp message IDs are processed once. A changed/paused destination, failed download or cancelled service produces a failure instead of rerouting or replaying the file.

Incoming bytes are stored transactionally with the exact request, binding, native session, owner and destination. Each materialized file uses its own private request/session directory, exclusive creation and a read-only file, with link and integrity checks. New incoming bytes live on disk with metadata in SQLite, without the former 100 MiB quota. Available-disk checks and per-request cleanup bound resource use; forwarding copies only reviewed bytes into a separate private file, using filesystem copy-on-write where supported. Files are never copied into project roots or automatically executed/extracted.

The master must pass explicit `attachmentIds` from the original open owner request to `master_dispatch`. Only selected workers are eligible. Copies receive new child-request IDs and separate staging paths. A retry with the same dispatch event is idempotent; changing its attachments is rejected. Reports and other requests cannot supply attachment authority. Text-only dispatch does not forward files implicitly.

CLI: `master --binding MASTER dispatch REQUEST-ID BINDING-ID EVENT-ID --attachments ID[,ID]`, with only the worker's task on stdin.

## Approved outgoing files

`prepare-file NAME REQUEST-ID /absolute/reviewed/file [--self]` requires local admin authority and a deployed backend advertising `preparation: stream-v1`. The CLI hashes a single reviewed descriptor, reserves its exact name/size/SHA-256 and destination, and streams bytes over authenticated loopback HTTP. The desktop's confirmed-document action uses the same local helper and passes only an artifact ID to the server; its old 10 MiB picker/base64 restriction is removed. File paths never enter server preparation APIs. Old JSON/base64 clients retain a 25 MiB encoding bound and must use streaming for larger files; this is a legacy encoding interface, not the file limit exposed by the CLI or desktop.

There is no fixed prepared-storage quota. Preparation is serialized; reads use 64 KiB chunks and backpressure, and SQLite stores metadata with an empty BLOB for streamed artifacts. Available space is checked for staging, encrypted temporary storage, and a 128 MiB headroom reserve. Incoming transfers and outgoing staging recheck available space as bytes arrive. The flusher processes one outgoing file at a time. Preparation and delivery each have a one-hour wall deadline with 30-second network inactivity limits. Slow/stalled connections and changing disk space can still fail below the size ceiling.

Delivery uses Baileys streaming encryption/message generation plus a bounded HTTPS upload callback. It honors `maxContentLengthBytes` advertised by each authenticated media host for the **encrypted** HTTP body, including padding and MAC, and will not upload to a host whose stated ceiling is too small. If all reported host limits are insufficient, delivery is marked failed with that concrete byte ceiling. Other network failures retain normal retry handling. Successful relay uses the existing stable WhatsApp message ID.

Staging verifies all bytes and common type signatures. Hashes are checked again before and during encryption. Owner, enabled native session, request, cancellation and destination/group membership are checked before relay. Symlinks, hard links, byte-count changes and hash mismatches fail closed. Signature checks are not complete installer validation: provenance, archive contents, architecture and published hashes still need review before preparing each actual build.

Lost preparation responses are recoverable through upload status; repeated identical preparations return the existing artifact. Startup removes interrupted reservations and private download scratch files. Routing rollback removes uncommitted incoming files; ordinary completion/cancellation cleans encrypted/download temps. Baileys can leave an encrypted OS temporary file after a process/OS crash during encryption. The bridge does not delete unidentified OS temp files; free-space checks remain in force. Synchronous routing transactions use bounded 64 KiB hash reads rather than whole-file buffers, but verifying/forwarding a very large attachment can briefly block the backend event loop.

`respond-file` queues the artifact under the same session/request and frozen destination. `delivery` distinguishes queued, sent and failed. Sent means relay succeeded, not that a phone received or opened the file. `liveLargeFileDeliveryVerified: false` stays explicit until real-phone testing. Source tests never establish live WhatsApp acceptance.

Replaced/cancelled requests invalidate files. Completed/reviewed files are eligible for cleanup after 24 hours; pending outgoing deliveries and unresolved incoming requests remain. `cleanup-media`, `cancel-file` and `cancel-attachments` remove eligible stored bytes. Cancellation cannot retract relay already in flight or content already read by a native session. Tombstone metadata makes expired references fail clearly.

## Roles and instruction lifetime

`/style NAME friendly|cheerful|professional|coding` changes one exact session; `master` may be used for the current master. Local CLI equivalent: `style NAME STYLE`. Admin API: `GET /api/roles`, `POST /api/roles` with `{bindingId, style}`. The default is friendly. Each setting persists independently and applies on the next work turn. Roles change language and formatting, never tools, trust, destinations, native permissions or factual standards.

| Adapter | Persistent operating instructions | Ordinary subsequent turn |
|---|---|---|
| Managed Codex | `developerInstructions` at thread creation/resume; restored on runtime restart or role-version change | Latest task plus request/scope/reply/attachment/version envelope |
| Managed Claude stdio | Supported `--append-system-prompt` for each native process; exact session resume | Latest task/envelope and structured images |
| Managed Claude public SDK | `systemPrompt: {type: 'preset', preset: 'claude_code', append: ...}` for each SDK query/resume | Latest task/envelope and structured images; no policy pasted into user prompt |
| Existing Mac desktop sessions | One initial role bootstrap in native history, plus a private immutable role document | Small role-version/document reference; reload if context was lost/compacted |
| Claude channel | MCP server instructions plus first role bootstrap and versioned document reference | Latest task/envelope via channel notification |

The installed Claude CLI documents system-prompt snapshotting as enabled by default, which can ignore changed append text on resume. Managed role adapters explicitly disable that snapshot using the supported `--system-prompt-snapshot off` option (public SDK `systemPrompt.snapshot: false`) so version changes take effect. Older CLIs that lack this option need a compatible version; no fallback drops the requested role silently. Provider system messages still exist on every model call; “once” refers to establishing persistent guidance separately from user-turn text, not eliminating system tokens from provider requests.

The desktop helper exposes text delivery, not a supported API for replacing persistent system/developer instructions in an arbitrary existing chat. Desktop bootstrap is therefore a documented history/reference fallback; it cannot guarantee an agent will remember instructions after compaction. It never edits shared project instructions to affect unrelated sessions. New bridge-owned master/worker folders retain their existing creation instructions; current role guidance is versioned separately. No code claims to override provider system messages.

The envelope distinguishes authenticated owner input, a delegated owner task and untrusted worker reports. Master instructions are not copied into worker prompts. Routine responses should usually stay around 800 characters or less in one short paragraph or a few bullets, expanding when requested or needed for important blockers/evidence, using WhatsApp `*emphasis*` and tasteful emojis. Long content is not blindly truncated. Workers write their own results; report acknowledgments should stay quiet unless a new actionable update is needed. `master_quiet` may include `resolveOutcome` to resolve the original owner request after all work is accounted for, or `master_resolve` can resolve it after earlier acknowledgments. The backend checks pending children, reports, creation and approvals; acknowledgment alone does not imply task success.

## Verification and release handoff

Tests cover immutable staging, owner/session/request isolation, links/tampering, allowed binary MIME types, caption/quote routing, duplicates, changed routes, cancellation, group membership rechecks, restart/cleanup, explicit forwarding, role version/restart behavior, native Codex image inputs and Claude SDK structured inputs. Provider adapter tests use controlled fake native transports; they do not establish live phone/model behavior.

Release integration still needs its ordinary build/install checks and real-phone verification with representative files, supported provider accounts/models, native permissions and each target platform. No live model task, application installation, pairing change or service restart is required by these tests. The separate integration chat owns request lifecycle, telemetry, hook correlation and desktop UI; style and media capabilities are exposed through authenticated APIs for that UI.

### Direct-build delivery remains pending

The old release `v0.7.0-preview.40180615532` advertises Apple Silicon DMG 451,350,520 bytes, Intel DMG 459,834,009 bytes, Windows x64 ZIP 368,733,142 bytes and Linux x64 TAR.GZ 503,006,022 bytes. These are below the native document ceiling but do not contain this correction. Advertised metadata is not byte-level artifact verification. The integration owner must identify intended new artifacts; each exact file still needs hash, format and architecture validation before preparation.

After the user explicitly requested a local build and restart, local build 2013 was installed with this correction and the latest verified UI. The live backend reports 2,097,152,000 bytes for incoming/outgoing documents and no fixed storage quota. WhatsApp reconnected; all 13 bindings, nine pending requests and background/keep-awake preferences were preserved. No build file or maximum-size document was sent. Four-platform release artifacts and real-phone maximum-size delivery remain unverified. See local-build-2013.md.

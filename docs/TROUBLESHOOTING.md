# Troubleshooting

| Symptom | Check / next step |
| --- | --- |
| WhatsApp disconnected | Open Home, check network and linked-device state, then reconnect if necessary. |
| No group listed | Use Refresh groups. Only supported owner-only groups can be used. Discovery failures retain prior saved results. |
| Saved Claude chat unavailable | Open that exact chat in the compatible Claude app; a saved catalog record is not a live inbox. Check account capability and project permissions. |
| CLI not signed in | Authenticate the chosen CLI through its normal flow, or choose a supported Desktop mode. Desktop account state cannot be copied into CLI. |
| New session fails | Read the recorded error. Recover or abandon that operation, or start a replacement. Native permission/account failures still need resolution. |
| Request submitted but no final reply | Inspect the target session and Activity. Native transport acceptance is not completion. Check the explicit reply command and hook trust. |
| Request uncertain after restart | Inspect the native chat before retrying. Do not replay a request that may have already acted. |
| Voice note fails | Check local speech readiness and supported audio limits. Confirm FFmpeg, whisper.cpp and the model exist; inspect the sanitized failure, not just transcription output. |
| Document cannot send | Prepare the specific authorized artifact and use its returned artifact ID. Do not send an arbitrary local path. |
| Mac stops responding when asleep | Keep Mac/network available. Idle-sleep prevention does not override every closed-lid/manual-sleep condition. |

## Collect useful evidence

Record the revision/app build, macOS, chosen provider and Desktop/CLI mode, timing, and request lifecycle state. Remove phone numbers, chat text, tokens, local usernames and recordings from shared diagnostics.

## Existing installations

The rename to Sidekick intentionally preserves the old state directory and service identifiers. Do not delete them to fix a naming issue. Changing or deleting them can remove pairing and recovery information.

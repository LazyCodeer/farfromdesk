# Manual Social sharing — 31 October 2026

Source: /Users/sagar/Documents/ChatGPT/Personal/whatsapp-session-bridge/.local/social-session-wiring-20261031
This ZIP is selected-file recovery only, not a standalone repository. Shared Social layout edits from thread 01a191bf-1a52-7a13-9376-f14d3b696889 are preserved. Do not overwrite newer files from this archive.

## Behavior
Select a saved card, click Share / Open in (share icon in its header). Choose Instagram, LinkedIn, X, Facebook, Threads, TikTok, YouTube, Reddit, WhatsApp or Other.
- X: bounded text intent. WhatsApp: wa.me text intent. Long encoded URLs fall back to the platform and full clipboard text, without truncation.
- Instagram/LinkedIn/Facebook/Threads/TikTok/YouTube/Reddit: copy caption and open fixed official platform URL; paste into a new post and manually upload media. No fabricated image-upload URL or unsupported promise of autofill.
- Export complete post: directory chooser, then unique new folder containing caption.txt and slide-01.jpg, slide-02.jpg, etc. Includes all validated slides in order. Cancellation saves nothing. Export errors remove only this operation's new partial folder.
- macOS share sheet: caption and all JPEG files through NSSharingServicePicker. Destination apps control which items are accepted. Temporary media are retained in the OS temp directory for asynchronous readers; not removed when the picker closes. Report chooser opened, never delivery.
- Other: export, copy and macOS chooser; no guessed platform URL.
- No Meta key, generation call, publish API, automatic send or draft-status mutation. Current code is desktop only. It does not provide a mobile share sheet or send files to a phone. TikTok/YouTube receive images/text, not a generated video.

## Tests / limitations
Automated focused suite: 31 passed, one existing conditional skip. Includes URL encoding/host control, long-caption fallback, cancellation/open failures, explicit-only opening, full ordered export/share and existing Social/card/carousel behavior. Final share suite: all 6 tests passed, including the added screen-to-dialog snapshot test. Targeted analyzer: clean across 9 changed source/test files. macOS build2318 command completed successfully (83.4MB), including the Swift share channel; final clean combined build remains owned by the other session. Live destination composers/accounts and real native receiving apps are NOT verified; no post/message sent. Platform login and attachment acceptance need owner checks.

## Owner checks after combined installation
1. Open Social → Drafts, select an image or carousel, click Share / Open in.
2. Export complete post; inspect caption.txt and all slides in the chosen new folder. Cancel a second export and verify no success claim.
3. Copy & open X or WhatsApp: verify caption text (including emoji/newlines), then attach an exported image. Do not press Post/Send unless desired.
4. Copy & open each other platform: verify destination and copied caption; manually create a post/upload supported media.
5. macOS share sheet: choose an available app and inspect all attachments before sending. Some services may omit mixed text/media.
6. Long captions remain complete on the clipboard even when browser prefill is unavailable.

## Build/install ownership
This session started a build2318 before coordination; another session had already started2319. Neither concurrent build output should be treated as the final combined package. Thread 01a191bf-1a52-7a13-9376-f14d3b696889 owns ONE clean final build, packaging, smoke and Local install after both settle. Installed Local was2317 at inspection. This session does not independently replace/restart Local. Keep normal FarFromDesk and one separate FarFromDesk Local only.

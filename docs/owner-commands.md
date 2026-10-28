# Owner chat commands

Telegram registers its command menu automatically with `setMyCommands` when the existing bot connects or reconnects. No BotFather menu configuration is required. Menu registration failure is exposed in connection status; typed commands still work. WhatsApp uses typed commands and has no bot menu.

- `/claude`: choose an enabled connected Claude session or proxy.
- `/codex`: choose an enabled connected Codex session or proxy.
- `/brain`: select the configured Meta brain. Disabled/missing-key states are explained, and model failure never falls back to a different session in this mode.
- `/screen`: use the existing password-protected Mac viewer entry flow. It does not grant native permissions. Setup, platform, password, lock and native access checks remain in the remote service/host. A signaling link is not evidence that a real phone can connect.
- `/back`: leave the explicit target and return to normal configured routing.
- `/help`: show descriptions and the current target. Existing commands remain supported.

If several connections fit, Telegram shows session buttons. Tap one, reply to its list with the number, send a plain number while that list is current, or use `/claude NUMBER` or `/codex NUMBER`. An exact, unique session name also works. Long lists use several button messages; numbers remain the same across them. WhatsApp keeps the numbered reply fallback. Choices expire after ten minutes and are tied to the saved exact connection identity. Paused, removed or changed connections fail closed; no sessions are created and no accounts/runtimes are switched. Target selections are isolated by owner destination. Replies to a target-choice list select that connection; replies to ordinary session messages still return to that session. Text and voice use the selected target; files use the selected session, while Brain mode asks the owner to choose a session for file delivery.

Only authenticated, top-level owner text can change modes or run commands. Forwarded text, quotes, file captions, voice commands and internal reports do not execute slash commands. Telegram accepts `@thisbot` suffixes and ignores commands addressed to another bot. Owner message IDs and existing choice consumption provide duplicate protection.

## Experimental WhatsApp polls

Numbered message choices remain the default. The local `whatsapp-choice-polls=true` setting opts into an additional single-choice poll for the same question; the original numbered reply stays available. This flag is deliberately off until a real linked-device self-chat trial passes. It is not enabled in production or automatically enabled by connecting WhatsApp.

The pinned Baileys version has automatic poll-update processing commented out. FarFromDesk explicitly decrypts raw poll updates using the stored creation secret and authenticated owner PN/LID identifiers. The decoded hash maps to the existing message-options row and uses its owner, destination, expiry, request, binding and already-answered checks. Labels never enter a command or permission parser. Unknown, tampered, multiple-choice, stale and non-owner votes are ignored or rejected. Uncertain poll sends are held without retry. Turning polls off prevents queued sends and vote handling.

Offline encrypted-vote fixtures pass. Real WhatsApp rendering and delivery/decryption are unverified. Test one harmless synthetic choice through an already authorized owner connection before enabling this feature for normal use; do not start a second client with production credentials.

Owner commands and their failures appear under Recent commands in the desktop Inbox. These are command records, not native coding tasks.

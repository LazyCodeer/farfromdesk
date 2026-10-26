# Control FarFromDesk with Telegram

Telegram is an alternative to WhatsApp. Choose WhatsApp or Telegram on the empty Home screen; your Codex and Claude coordinators stay the same. Existing replies always return to the account and channel that requested them. Choosing another channel does not redirect queued replies.

## Connect in three steps

1. Select **Telegram** on Home. Open **@BotFather**, create a dedicated bot with `/newbot`, and paste its token into FarFromDesk's **Bot token** field. Do not paste it into a coding session or commit it.
2. Click **Connect bot**, then **Open Telegram**. Tap **Start** in the private bot chat. The pairing link expires after ten minutes; keep it private.
3. Return to FarFromDesk and confirm the displayed Telegram name and numeric account ID. No account can control the app until you confirm it locally.

Then message your bot normally: “Show my recent sessions”, “Claude, check the website”, or “Tell me what I worked on today”. Reply to a session's message to continue that session. Reply to a permission message with a typed “Yes, allow it” or “No, deny it”. Voice recordings cannot approve actions.

The computer and FarFromDesk background service must stay running. Telegram does not change Claude or Codex account access, workspace trust or native approval requirements. In particular, the Claude Desktop prepared-chat flow still requires the owner's Send action.

## Files, voice and privacy

- Text, quoted replies, session discovery, delegation, request progress and permission decisions use the shared coordinator.
- Voice notes use the speech engine selected in FarFromDesk: the on-device model or the user's configured speech provider. Local transcription supports up to five minutes.
- Telegram's hosted Bot API permits downloads up to **20 MB** and document uploads up to **50 MB**. FarFromDesk checks those limits and retains its file integrity and request-ownership checks.
- Only the locally confirmed private-chat account can send requests. Groups, channels, bots, edited messages and other senders are ignored.
- Bot tokens are stored in the app's private state directory in a file with restricted user permissions. They are never returned by the status API or written into SQLite. Disconnect removes the token and pairing.
- Telegram bot conversations are cloud chats, **not end-to-end encrypted Secret Chats**. The official Bot API is supported, but Telegram's terms and rate limits still apply; no integration can promise zero suspension risk.

## Switch messaging apps

Choosing an app is saved separately from connecting an account. If no bot or WhatsApp account is configured, **Choose another app** switches directly without a disconnect warning. Unfinished pairing asks to **Cancel setup and switch**. Saved or connected accounts require confirmation.

Use the **Messaging app** selector in Settings. Home also has **Disconnect** for the current account. The confirmation explains what will disconnect. After confirmation, FarFromDesk logs out WhatsApp or disconnects Telegram and removes its saved bot token, then opens the other app’s setup. Returning to WhatsApp requires scanning a new QR code; returning to Telegram requires reconnecting and pairing the bot. Your coding coordinators and history stay saved.

If WhatsApp is registered but offline, reconnect it before switching so logout can finish. A failed logout keeps the current app selected. Waiting replies remain tied to their original account and are held until that account reconnects; they never migrate to the new channel.

The browser preview has a **Preview flow** menu for empty Home, WhatsApp setup/QR/connected, and Telegram setup/pairing/confirmation/connected/expired/error. This menu and sample accounts exist only in the preview.

## Reconnect and delivery

FarFromDesk uses outbound HTTPS long polling; no public webhook, inbound port or hosted relay is required. Use a dedicated bot: an existing webhook or another polling client is reported as a conflict, never removed silently. Pausing background forwarding stops both messaging connections.

Update offsets and request IDs survive restart. Repeated incoming updates do not dispatch a task twice. When Telegram explicitly returns a rate limit, sending waits for its retry interval. A network interruption during sending is marked **uncertain**, because Telegram's send API has no client idempotency key; FarFromDesk does not blindly resend it. Check the bot conversation before sending a replacement request.

“Sent” means Telegram accepted the message. The Bot API does not provide recipient delivery/read receipts. It is not evidence that a coding task succeeded.

## Validation status

The implementation is covered by mocked Bot API tests and Flutter widget tests. Real bot pairing and live Telegram delivery require a bot token entered locally by the owner and are not implied by passing automated tests. Telegram support is included starting with version 0.7.8. Local testing established pairing and replies on the owner's Mac; it does not establish compatibility with every platform, account or network.

Official references: [Bot API](https://core.telegram.org/bots/api), [Bot tutorial and BotFather](https://core.telegram.org/bots/tutorial), [Bot FAQ](https://core.telegram.org/bots/faq).

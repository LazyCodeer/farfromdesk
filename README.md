<p align="center">
  <img src="docs/assets/farfromdesk-banner.svg" alt="FarFromDesk — your coding sessions, one WhatsApp message away" width="960" />
</p>

<p align="center">
  <strong>Step away from your desk. Stay close to your work.</strong><br />
  Connect WhatsApp to your coding assistants on your Mac.
</p>

<p align="center">
  <a href="https://github.com/LazyCodeer/farfromdesk/releases"><strong>Download for Mac</strong></a> ·
  <a href="#get-started-in-three-steps">Get started</a> ·
  <a href="#what-you-can-do">Features</a> ·
  <a href="#questions">Questions</a>
</p>

<p align="center"><strong>Private preview</strong> · macOS 14+ · Apple Silicon & Intel previews</p>

Ask for updates, give your coding assistants instructions, and get their replies in WhatsApp. Your assistants keep their own context and tools. You choose which sessions to connect.

## Download FarFromDesk

The existing `v0.6.2-preview.2` download was built under the earlier **Sidekick** name and contains `Sidekick.app`. New automated releases use FarFromDesk; choose the name shown in the release notes. The previous release files have not been relabelled.

Visit [GitHub Releases](https://github.com/LazyCodeer/farfromdesk/releases), open the newest FarFromDesk preview, and expand **Assets**. Choose **arm64** for Apple Silicon (M-series) or **x86_64** for Intel. Download the **DMG** for drag-and-drop installation or the **ZIP** containing the same app. The “Source code” files GitHub adds automatically are not the app.

Requires macOS 14 or later, a compatible signed-in coding app, and Python 3 for the native desktop helper.

Open the DMG and drag **FarFromDesk.app** to Applications, or unzip the ZIP and move the app there. Open it to begin setup. The download includes the local voice transcription tools and model.

**Access:** The repository and its downloads are private. You must be signed into a GitHub account with access.

**Preview status:** Intel is cross-built and still needs testing on an Intel Mac. These previews are not Apple-notarized. macOS may block it. It is intended for invited testers; a notarized release is still needed for a normal public install experience. Do not disable your Mac's security protections to run it.

## Windows and Linux

**Coming soon.** Windows and Linux apps are in the pipeline. Downloads will appear in [Releases](https://github.com/LazyCodeer/farfromdesk/releases) when they are ready.

## Get started in three steps

### 1. Connect WhatsApp

Open FarFromDesk and scan its QR code from **WhatsApp → Settings → Linked devices → Link a device**. Choose **Message yourself** or a supported private group containing only your account.

### 2. Choose your assistant

Choose Codex or Claude and the Desktop or CLI option you use. Connect an existing coordinating session or create one. Your app's normal sign-in, account limits, and permissions still apply.

### 3. Send a message

Ask FarFromDesk to show your sessions, select the ones you want, and send an instruction or voice note. Keep your Mac awake, online, and your chosen coding apps available.

## Your work, a message away

> “Show my recent sessions.”

> “Give me an update on the website redesign.”

> “Ask that session to fix the mobile navigation.”

> “Send me the result when it's ready.”

These are example requests. FarFromDesk routes them to your selected assistants and brings their replies back to you.

## What you can do

| | |
| --- | --- |
| **Stay connected to multiple sessions** | Add another session without disconnecting the ones already selected. |
| **Find the right conversation** | Browse recent sessions, search by name, or ask for older ones. |
| **Send a voice note** | Supported recordings are transcribed on your Mac and handled like text requests. |
| **Receive files and updates** | Get approved documents and progress from your selected assistants. |
| **Choose where replies go** | Use your personal WhatsApp chat or a supported owner-only private group. |
| **Stay in control** | Review supported permission requests and see unfinished work in Activity. |
| **Change your assistant** | Switch the coordinating session or platform from Home. |
| **Work while your screen is locked** | Optionally prevent idle sleep while keeping your Mac locked. |

## How it works

**Your WhatsApp → FarFromDesk on your Mac → Your selected coding sessions → Replies in WhatsApp.**

FarFromDesk connects to the assistants you already use. It does not replace their subscriptions or account permissions. The selected coordinating session helps direct your requests to the right worker sessions.

## Works with your tools

FarFromDesk has **Codex Desktop**, **Codex CLI**, **Claude Desktop**, and **Claude CLI** options. Availability depends on your installed version, sign-in, account, and whether the selected session can be reached.

A chat visible in history may need to be opened before FarFromDesk can connect. A Desktop login does not automatically sign you into the CLI. Not every version and account combination has completed a real-phone test.

## Private by design, with you in control

- Your linked account and selected destination control incoming requests.
- Voice transcription happens on your Mac. WhatsApp and your coding assistants still use their normal network services.
- Your assistants retain their normal permissions. FarFromDesk does not isolate an assistant that already has broad file access.
- Uncertain requests are held for review rather than automatically repeated.

FarFromDesk uses an unofficial WhatsApp connection and is not affiliated with WhatsApp, Meta, Anthropic, or OpenAI. Changes to those services can affect compatibility.

## Questions

**Does my Mac need to stay on?** Yes. FarFromDesk runs on your Mac, so it must stay awake and connected for real-time control.

**Can I close the lid?** The awake option prevents idle sleep; it does not override every closed-lid condition. Supported external-display setups may keep the Mac available. It never removes your lock-screen password.

**What happens if the app closes during a request?** Request history is saved. Activity shows work that needs a reply or review. If a request may already have run, check its native conversation before retrying.

**Can I use more than one session?** Yes. Selecting a new session adds it to the connected set. Quote a reply to address that particular session.

**Where do updates appear?** New app downloads and release notes appear in [GitHub Releases](https://github.com/LazyCodeer/farfromdesk/releases). Automatic in-app updating is not available yet.

**Need help?** See [Troubleshooting](docs/TROUBLESHOOTING.md). For a bug report, include your app version, platform, and sanitized steps. Never share pairing QR codes, credentials, or private recordings. Report sensitive issues using [our security policy](SECURITY.md).

## License

[MIT](LICENSE)

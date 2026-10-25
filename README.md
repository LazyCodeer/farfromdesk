<p align="center">
  <img src="docs/assets/farfromdesk-banner.svg" alt="FarFromDesk — your coding sessions, one WhatsApp message away" width="960" />
</p>

<p align="center">
  <strong>Step away from your desk. Stay close to your work.</strong><br />
  Connect WhatsApp to your coding assistants on your computer.
</p>

<p align="center">
  <a href="https://github.com/LazyCodeer/farfromdesk/releases"><strong>Download desktop previews</strong></a> ·
  <a href="https://ffd.codecylabs.com">Website</a> ·
  <a href="#get-started-in-three-steps">Get started</a> ·
  <a href="#what-you-can-do">Features</a> ·
  <a href="#questions">Questions</a>
</p>

<p align="center"><strong>Private preview</strong> · macOS · Windows · Linux desktop previews</p>

Ask for updates, give your coding assistants instructions, and get their replies in WhatsApp. Your assistants keep their own context and tools. You choose which sessions to connect.

## Download FarFromDesk

Visit [GitHub Releases](https://github.com/LazyCodeer/farfromdesk/releases), open a **0.7.0 shared desktop preview**, and expand **Assets**. Older releases contain only the earlier Mac app. GitHub's automatic “Source code” downloads are not the installed app.

| Your computer | Download | Requirements |
| --- | --- | --- |
| Mac with Apple Silicon | `macos-arm64.dmg` or `.zip` | macOS 14+ |
| Mac with Intel | `macos-x64.dmg` or `.zip` | macOS 14+ |
| Windows PC | `windows-x64.zip` | Windows 10/11 x64; supported signed-in CLI |
| Linux PC | `linux-x64.tar.gz` | glibc 2.35+, GTK 3, desktop session; supported signed-in CLI |

On Mac, drag **FarFromDesk.app** from the DMG into Applications, or extract the ZIP. Windows and Linux archives contain the app and its bundled backend; extract the whole folder together. Each release includes optional installation scripts, checksums and release notes. Local voice tools and the multilingual model are included, so the first voice note needs no model download.

**Private preview:** You need a GitHub account with repository access. Mac builds are ad-hoc signed and not Apple-notarized; Windows builds are unsigned. Your operating system may block them. Do not disable security protections. A signed public release and public one-command installer are not available yet.

Mac supports the existing Desktop integrations (which require Python 3) and CLI options. Windows and Linux currently support **Codex CLI and Claude CLI**; controlling their Desktop chats is not available. Native startup and voice checks run on all four build targets, but real-phone/provider account testing is still required on each operating system. ARM Windows/Linux and older Linux distributions are not supported by this preview.

## Get started in three steps

### 1. Connect WhatsApp

Open FarFromDesk and scan its QR code from **WhatsApp → Settings → Linked devices → Link a device**. Choose **Message yourself** or a supported private group containing only your account.

### 2. Choose your assistant

Choose Codex or Claude and an available Desktop or CLI option. Connect an existing coordinating session or create one. Your app's normal sign-in, account limits, and permissions still apply.

### 3. Send a message

Ask FarFromDesk to show your sessions, select the ones you want, and send an instruction or voice note. Keep your computer awake, online, and your chosen coding apps available.

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
| **Send a voice note** | Supported recordings are transcribed on your computer and handled like text requests. |
| **Receive files and updates** | Get approved documents and progress from your selected assistants. |
| **Choose where replies go** | Use your personal WhatsApp chat or a supported owner-only private group. |
| **Stay in control** | Review supported permission requests and see unfinished work in Activity. |
| **Change your assistant** | Switch the coordinating session or platform from Home. |
| **Work while your screen is locked** | Optionally prevent idle sleep while keeping your computer locked. |

## How it works

**Your WhatsApp → FarFromDesk on your computer → Your selected coding sessions → Replies in WhatsApp.**

FarFromDesk connects to the assistants you already use. It does not replace their subscriptions or account permissions. The selected coordinating session helps direct your requests to the right worker sessions.

## Works with your tools

On Mac, FarFromDesk has **Codex Desktop**, **Codex CLI**, **Claude Desktop**, and **Claude CLI** options. Windows and Linux currently offer the CLI options. Availability depends on your installed version, sign-in, account, and whether the selected session can be reached.

A chat visible in history may need to be opened before FarFromDesk can connect. A Desktop login does not automatically sign you into the CLI. Not every version and account combination has completed a real-phone test.

## Private by design, with you in control

- Your linked account and selected destination control incoming requests.
- Voice transcription happens on your computer. WhatsApp and your coding assistants still use their normal network services.
- Your assistants retain their normal permissions. FarFromDesk does not isolate an assistant that already has broad file access.
- Uncertain requests are held for review rather than automatically repeated.

FarFromDesk uses an unofficial WhatsApp connection and is not affiliated with WhatsApp, Meta, Anthropic, or OpenAI. Changes to those services can affect compatibility.

## Questions

**Does my computer need to stay on?** Yes. FarFromDesk runs on your computer, so it must stay awake and connected for real-time control.

**Can I close the lid?** The awake option prevents idle sleep; it does not override every closed-lid condition. Supported external-display setups may keep the Mac available. It never removes your lock-screen password.

**What happens if the app closes during a request?** Request history is saved. Activity shows work that needs a reply or review. If a request may already have run, check its native conversation before retrying.

**Can I use more than one session?** Yes. Selecting a new session adds it to the connected set. Quote a reply to address that particular session.

**Where do updates appear?** New app downloads and release notes appear in [GitHub Releases](https://github.com/LazyCodeer/farfromdesk/releases). Automatic in-app updating is not available yet.

**Need help?** See [Troubleshooting](docs/TROUBLESHOOTING.md). For a bug report, include your app version, platform, and sanitized steps. Never share pairing QR codes, credentials, or private recordings. Report sensitive issues using [our security policy](SECURITY.md).

## License

[MIT](LICENSE)

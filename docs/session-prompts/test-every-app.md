Stop adding features. Your job now is a live test pass of every app tool on this Mac, before the hackathon deadline. Report what works and what does not, with evidence.

Repo: /private/tmp/ffd-pr, branch codex/local-desktop-work. Another session (Claude) is working on the brain's understanding in a separate worktree at /Users/sagar/Documents/ChatGPT/Personal/whatsapp-session-bridge/.local/brain-understanding, branch claude/brain-understanding. Do not edit these files, because Claude owns them right now: src/app-tools/retrieve.ts, src/app-tools/golden.ts, src/brain-device.ts, src/meta-brain.ts, src/meta-model.ts, src/muse-session.ts. If a test shows one of them is wrong, write the failing message and the cause in your report instead of fixing it.

## Step 1: land what you already have
1. Finish the full `npm test` you started. If the only failures are the ones that also fail on a clean HEAD (http-hooks, morning-brief-transport), commit your 9 uncommitted files and push. 74b2789 is not pushed yet either, so push it too. PR #49 must have the tool layer.
2. Ship a Local build with the EventKit helper bundled (FFD_LOCAL_BUILD=1). Write down the build number.

## Step 2: test every app, live, through the real chat
Use script/live_transcript.mjs (the app's own composer). Make sure /brain is selected first. For each row, record the exact message, the exact reply, and PASS or FAIL. Where a row writes something, check the real app afterwards and say what you saw.

Notes
- "Check my recent notes" (must return note content, not window labels)
- "summarise my notes"
- "find my note about <a word from a real note>"
- "write a note: hackathon test <time>", then confirm the note exists in Notes, then delete it with the delete tool

Calendar (EventKit)
- "Check my calender" (typo on purpose)
- "what is on my calendar today", "any meetings tomorrow"
- "add a calendar event hackathon test tomorrow at 6pm", then confirm it, then delete it

Reminders (EventKit)
- "check my reminders"
- "remind me to call mom at 5", then confirm it, then complete it, then delete it

Mail
- "check my mails", "find the email from <a real sender>"
- "draft a reply to <sender> saying thanks". It must draft and never send. Confirm in Mail Drafts.

Finder, Safari, Music, Messages
- "list files in downloads", "show my safari tabs", "what is playing", "any new messages"

Robustness
- The same message twice in a row: it should not do the work twice.
- A message while another device action is running: it must say it is busy.
- A Mac permission that has not been granted yet: the reply must name the grant and where to allow it, never "the action did not complete".
- /back, then "check my notes": write down where it goes. After /back it goes to the configured proxy (Muse #3 today). Say whether Muse now runs, because Claude fixed Muse's sign-in (it used the app's private HOME).

## Step 3: report
One table with each row: message, reply, PASS or FAIL, cause if FAIL. Then a list of the FAIL rows, with the file and line where the cause is if you found it. Name the build number and commit hashes. Say plainly what you could not test and why, such as a permission prompt only the owner can click. Do not claim a row passed unless you saw the reply and checked the app.

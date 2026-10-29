# Stuck notices: initial coverage

When the Meta Brain and its status summaries are enabled, the bridge checks
the paired WhatsApp self-chat for tasks with verified owner and item origins.
It can report:

- A dispatched or submitted task with no recorded progress for 10 minutes.
- An open native permission or question that is bound to the exact task
  request and still awaits an answer. If a session-reported permission was delivered
  and its recorded request fits in one notice, the notice repeats it and offers
  a direct quoted reply: `1` denies and `2` allows that exact pending request.
  Review the request before deciding. This sends the decision to the session;
  the bridge cannot verify what the session does next. It does not operate macOS
  dialogs itself. Long, bridge-originated or unavailable requests must be
  answered on the original permission message.
- A delivered, unexpired session choice that has not been selected, when its
  original session and request can be verified. This does not establish that
  the session itself is blocked. If an owner follow-up may have answered a
  choice but cannot be matched to one message, the detector stays quiet. When
  the complete original question fits in one notice, reply to that notice with
  an offered number. It uses the original choice and task-contract checks; it
  does not grant a native permission.
- Two consecutive recorded task failures with the same known error category.
- A task's latest recorded failure has an authentication error. Check the
  session's sign-in yourself on the Mac. This does not identify a login page
  or submit credentials.

Change the idle limit with `/stuck interval 20`, using 1 to 1440 minutes.
Send `/stuck dismiss CODE` to dismiss a delivered notice within 10 minutes.
Dismissal does not grant permission, change the task, or start work. To see
the Mac, separately send `control my screen`; answer a permission question on
its original message.

The detector scans at most 100 items and sends at most three new notices per
maintenance tick. A rotating cursor gives other items a turn, so a large
simultaneous backlog can take more than a minute to cover. It suppresses the
same incident until new evidence appears. An expired notice that is provably
unsent may be replaced; an interrupted or uncertain send is not retried.

Meta Wonder receives only fixed signal categories. No task text, names,
permission prompts, identifiers or credentials are sent as prompt data. If
Meta is unavailable the notice uses a fixed introduction.

This initial version does not scan group chats or Telegram, inspect screens,
detect popups or sign-in pages, click buttons, approve native
  permissions without the owner's explicit decision, merge changes, or start unrelated follow-up work. Existing native prompts
that lack an exact request identity cannot be attributed and are not included.
The message includes no screenshot. These limitations mean this is not yet the
complete proactive unblock workflow described in the hackathon plan.

## Public CI watches

In the owner's WhatsApp self-chat, send
`/stuck ci #ITEM https://github.com/OWNER/REPO/pull/NUMBER` to watch a public
PR for an open owner-linked item. A session's reported link does not authorize
the watch. The bridge reads the public GitHub API without credentials, and
can report one exact check it observed failing on the PR's head. It rechecks
that head and run before delivery; the notice identifies the observation time.
This is historical evidence about one check, not overall CI or merge readiness.
It does not merge the PR or grant permission to do so.

Each watch expires after 24 hours. Remove one with `/stuck ci remove #ITEM`.
Owner, item, policy or session changes can invalidate the watch. Checks are
rate-limited and only the first 100 returned runs are considered, so delivery
is not guaranteed within one minute. A never-attempted notice is re-observed
after a restart; an uncertain send is not replayed.

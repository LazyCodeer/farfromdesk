# Stuck notices: initial coverage

When the Meta Brain and its status summaries are enabled, the bridge checks
the paired WhatsApp self-chat for tasks with verified owner and item origins.
It can report:

- A dispatched or submitted task with no recorded progress for 10 minutes.
- An open native permission or question that is bound to the exact task
  request and still awaits an answer.
- Two consecutive recorded task failures with the same known error category.

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
detect popups or sign-in pages, query CI or PRs, click buttons, approve native
permissions, merge changes, or start follow-up work. Existing native prompts
that lack an exact request identity cannot be attributed and are not included.
The message includes no screenshot. These limitations mean this is not yet the
complete proactive unblock workflow described in the hackathon plan.

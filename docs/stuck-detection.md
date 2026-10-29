# Stuck notices: initial coverage

When the Meta Brain and its status summaries are enabled, the bridge checks
the paired WhatsApp self-chat for tasks with verified owner and item origins.
It can report:

- A dispatched or submitted task with no recorded progress for 10 minutes.
- An open native permission or question that is bound to the exact task
  request and still awaits an answer.
- A delivered, unexpired session choice that has not been selected, when its
  original session and request can be verified. This does not establish that
  the session itself is blocked. If an owner follow-up may have answered a
  choice but cannot be matched to one message, the detector stays quiet.
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

## CI experiment

The unwired `stuck-ci-observer` prototype can compare one explicitly
owner-approved public PR, exact head and exact check-run ID against fixed
GitHub API responses. It re-reads both the run and the PR head and returns a
timestamped historical observation of that particular run only. It does not
establish current aggregate CI, required checks, review state or merge
readiness. Either source can change again after a read; any eventual sender
must revalidate both the exact run and PR head at delivery and describe the
observation as historical. The prototype cannot fetch or notify by itself,
and has no authority adapter or production caller.

The existing product does not store the owner's approval of a particular PR,
repository, revision and check run for an item. A PR link in a session's
report is an unverified claim, not that approval. Before wiring this feature,
add a delivered owner approval and durable owner/chat generation-bound record,
a bridge-owned fixed-origin transport, and tests for revocation, changed PR
head and uncertain delivery. Do not silently infer merge readiness, merge a PR,
or treat an old failed run as the current CI state.

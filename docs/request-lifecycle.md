# Request lifecycle and diagnostics

An incoming owner request, a delegated worker task, a worker report, an agent reply and a WhatsApp delivery are different records. None alone proves that the requested work succeeded.

## Resolving coordinated work

Workers reply against their exact request IDs. The coordinator acknowledges reports with `master_quiet`. A plain acknowledgment leaves the original request open for further authorized work. When coordination has finished, the coordinator explicitly supplies `resolveOutcome` to that acknowledgment, or calls `master_resolve` with the original owner request and an outcome (`done`, `blocked`, `reviewed`, `cancelled`). This resolves tracking without sending a duplicate summary.

Resolution requires all delegated tasks and other reports to be terminal and no pending creation or relevant native approval. Legacy reports are checked through their original parent links too. A worker cannot resolve another binding's owner request. Reply queueing, final status and the worker report are saved atomically. Retrying a final does not send it again.

`completed` means the reply/lifecycle was recorded. `outcome` carries the agent's explicit disposition; it is not inferred from a provider finishing a turn. Historical completed requests retain unknown outcomes. Owner review and auto-close remain distinct from task success and do not replay work.

## Creation versus execution

Creation status `ready` only means provisioning finished and the task was queued. Creation status responses also expose `taskRequestId`, `taskStatus`, `execution`, `outcome`, `currentError` and `lastError`. A successfully created session can have blocked execution.

Managed Codex reads its effective project configuration before starting a worker session or resuming a runtime. A missing environment variable required by the selected custom provider fails before task execution. This does not prove authentication, quota or remote model access. It never changes credentials or permissions. A preflight failure before `thread/start` is recorded separately so an explicit recovery can perform the first creation on that same binding; an uncertain actual submission is never blindly retried.

A new correlated progress reply changes an uncertain/failed request to awaiting reply and clears its current error, while retaining its last error and time. A retry performed outside the bridge remains unverified until correlated evidence arrives. No model-producing polling is added.

## Reply duplication and length

Direct and hook final replies are deduplicated using the exact binding, request and real provider turn, in either arrival order. Progress does not suppress a subsequent native final. Different requests or turns are not suppressed by a binding-wide time window. Unlinked native hooks are saved locally for Activity review instead of guessing a recipient. Local updates are capped at 500 records, expire after seven days, and their text is fetched only when opened.

Default response instructions ask for roughly 800 characters, expanding when the owner requests detail or essential blockers/evidence require it. Messages are not blindly truncated.

## Voice notes

Voice state `processed` means transcription reached a queued request or an explicitly handled bridge command. Routing failures use `routing_blocked`, with a useful reply. Download, decode, transcription and routing emit independent durations and safe error categories. A transcript is not evidence that an agent performed an action. Sender, destination, selection-change checks, typed approval requirements and duplicate protections still apply.

Activity shows failed/interrupted/routing-blocked voice notes even when no agent request was created. It displays request timelines on demand. Diagnostics omit recordings, transcripts, file paths and raw provider error output.

## Observed timings and delivery

New requests record receipt, submission, first reply and final reply timestamps, an attempt ID and available real turn IDs. Append-only events carry available packaged source revision and allowlisted metadata. Legacy stage timestamps stay null; migration times must not be used as historical performance measurements.

Outgoing replies carry a request link and kind. Sending records acceptance by the WhatsApp transport. Delivered/read timestamps are populated only from actual matching WhatsApp receipt events for the saved message ID and destination. A server acknowledgment is not a delivery/read receipt. Receipt availability depends on WhatsApp and its privacy settings; missing receipts remain unknown. No receipt certifies task success.

Provider token diagnostics use actual provider-reported values when available. A Codex usage event is a snapshot of `tokenUsage.last`, not an additive billing item; repeated snapshots must not be summed. Claude reports per-turn input/output token usage when available. No per-request dollar cost is inferred from cumulative SDK estimates.

## Local verification

The regression suite covers request authorization, atomic resolution, pending children/reports/approvals, legacy links, reply idempotency, both hook ordering cases, voice routing failures, safe diagnostics, provider preflight and receipt isolation. Flutter widget tests cover on-demand Activity diagnostics and minimum-window layouts. The optional local speech fixture tests the configured FFmpeg/Whisper engine, silence/corruption rejection and temporary-file cleanup.

Phone delivery and native end-to-end action behavior require a test against an installed build containing these changes. Passing local tests does not establish that the running app has been upgraded. Existing historical requests are not silently marked successful or replayed.

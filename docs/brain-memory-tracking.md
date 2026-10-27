# Local brain memory and tracking repair

Local combined build 2203. No public release.

## Causes reproduced

- Interpretation had the current message and board only. It had no recent conversation, persisted choices or notification intent.
- Numeric responses could be intercepted by an older session menu.
- Direct brain answers bypassed request correlation, so the ledger lacked transport evidence.
- Newly queued items had no session and remained "not started".
- Native queue acceptance was treated as current execution state even after the native turn was interrupted.
- Simple recent-session queries took a model/proxy round trip and repeated five-row catalogs without a time filter.

## Behavior

- Up to 12 recent owner messages and brain replies are provided as bounded, destination-scoped historical context. Each owner message is capped at 2,000 characters and each response at 1,500. They are context, never new authority.
- Status questions reuse the current topic. Ambiguous status/watch choices persist for 30 minutes and survive restart. A new task or list clears the old question. A task-choice number cannot operate an older session-selection menu.
- Literal greetings, item lists, current-topic status, completion watches and recent session queries are handled locally. Other language and task interpretation still uses the configured model; no language setting is forced.
- `let me know once it's done` (including the observed `itls` transcript) registers a durable watch rather than starting another native job. Watches pause with status policy/forwarding, keep their destination, support cancellation, and never replay native actions. A final already queued to the owner satisfies the notification instead of generating a duplicate. Completion requires explicit outcomes plus final-reply evidence for the linked work; it is described as reported completion, not owner verification.
- Direct replies record queued/retrying/sent separately. Historical brain replies are correlated by exact saved source/destination without resending or inventing sent times.
- Queued items record the responsible session and progress state. All linked explicit completion outcomes plus final replies can move the board to reported done. Interrupted/failed work stays blocked, not completed.
- The native Codex observer uses read-only `thread/read`, matches the exact request envelope and thread/cwd, and refuses ambiguous matching turns. It never resumes a thread. An interrupted turn or a completed turn lacking a recorded bridge reply becomes uncertain, without retry. Unknown or unavailable observations retain saved evidence. The ledger refresh is admin-only and bounded to three jobs, with an eight-second per-process deadline and 15-second observation cache. Claude retains saved bridge evidence; fresh native-turn reconciliation is not implemented for Claude.
- Recent-session questions query the chosen catalog directly, filter activity timestamps, and return up to 50 rows from at most six pages. Partial results are labeled. No generic title filter hides user sessions; earlier test-chat pollution remains a separate cleanup issue.
- Future proxy folders use `~/.farfromdesk/coordinators`. Existing Personal Bot identity/cwd is preserved. Instructions prefer actually exposed request-bound MCP tools and otherwise use FFD; a denied permission is not a reason to switch routes.

## Validation

Regression fixtures include the actual short follow-ups, numeric choice, notification request and misspelled recent-session query. They use isolated state and fake inference/native calls. Coverage includes restart, recipient separation, policy denial, expired choices, transaction rollback, historical delivery backfill, duplicate notification suppression, native exact-request matching and admin authorization. The live post-install evidence is recorded outside source in `MEMORY-FIX-REPORT.md` and `memory-build-verification.json`.

No failed owner request is automatically replayed. Existing native permissions and the production app are unchanged.

## Companion repair (after build 2203)

- **Fresh update versus saved status.** "Ask update from codex" or "check with it for an update on P1" sends one status-only question to the item's proven owner: an enabled, connected worker, or the proxy when the proxy itself owns the item. The question says to report existing progress, results and blockers only, never to resume, rerun, change files or message anyone. "Update on P1" without ask wording reads the saved status. Status questions are kept out of the item's run history, so an uncertain question never marks the work blocked, and nothing is resent.
- **Item codes anywhere.** `#N`, `item N` and the T/P/D codes from the owner's last list resolve anywhere in a sentence. The model also receives that code map and the items waiting on the owner.
- **Replaced or paused owners.** If an item's latest dispatch was replaced, or its session was removed or paused before a final answer, the board shows "waiting on owner" with a note. Status, update and follow-up messages explain what happened and offer `start #N again` or `mark #N as done`. Nothing is moved to the new proxy on its own. Only `start #N again` sends the original request, word for word, to the current default proxy.
- **Memory.** Recent conversation includes owner messages from every route, plus worker and proxy replies on delegated children (system notices excluded). The greeting names items waiting on the owner.
- **Not done here.** Extracting decisions and constraints, Claude native-turn observation, and Atlas tool readiness stay out of scope.

## Combined local 2204 integration review

The companion handback now rejects negated/quoted update instructions, respects enabled-provider policy and preserves the requested provider across a numbered choice. Queuing a status question is described as queued, not delivered. Conversation memory includes correlated brain answers and restricts all replies to the current destination. Explicit owner restarts mark a new attempt boundary for ownership/completion while retaining old dispatch evidence.

Validation: 480 backend tests, 478 passed, 2 skipped, no failures using isolated test settings; TypeScript check clean. These checks use synthetic interpretation and do not certify live phone companion behavior or Atlas tool readiness. Durable extraction of decisions and constraints remains future work.

The latest saved owner inputs “How are you” and “Task 1” now have local greeting/status paths with a regression test; this is code-level validation, not a replay of those messages.

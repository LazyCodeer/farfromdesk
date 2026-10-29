# Intel smoke diagnostics

This workflow builds and packages the Intel app with the release commands and
runs the same packaged-app smoke assertions. It has read-only GitHub
permissions and has no publish step. It runs only on a pull request changing
these diagnostic files, or through workflow dispatch after the workflow exists
on the default branch. The version input defaults to 0.9.4 and must match the
release being diagnosed.

An optional Node preload writes only the supervisor's PID and a timestamp to
a fresh temporary directory. A separate Python observer samples the known
process tree, process state and CPU every 15 seconds, capped at 32 samples.
The observer never emits process arguments, environment, paths or app state.
The observer and log tail are stopped when the smoke step finishes. The
ordinary release smoke supervisor and its assertions are unchanged.
On cancellation, the wrapper also stops its own supervisor child. It does not
signal detached descendants of that child; GitHub's isolated runner is
responsible for their cleanup.

An Ubuntu job independently prints the GitHub API's status of the Intel job
every 30 seconds, capped at 85 samples. It cannot see live Intel logs or prove
runner health. The short observer-only JSONL is uploaded only when the Intel
runner returns control; the live step also emits it.

Interpretation requires caution:

- Fresh event-loop timestamps while readiness stalls show that the
  supervisor's event loop and temporary filesystem are making progress.
- A growing heartbeat age with ongoing observer samples shows that the Node
  event loop **or its heartbeat writes** are not making progress. It does not
  identify which system call is responsible.
- Both streams stopping while GitHub still reports the job running suggests a
  runner, host or logging-transport problem, but does not distinguish them.
- The process tree is a best-effort snapshot of current parent relationships.
  It may miss reparented processes and must not be used to signal unknown PIDs.

The workflow can fail in packaging, including the previously observed DMG
`Resource busy` failure, before the smoke diagnostic starts. The workflow
does not change error handling, release gates, or publish a release.

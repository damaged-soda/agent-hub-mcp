# Routed post-PR review

Use this workflow only in one of these two cases:

1. This process has just successfully created or materially updated a PR and the machine review
   policy requires the cross-review step.
2. The user explicitly asks to use Agent Hub's configured/routed cross-review.

A request to review a diff, change, or existing PR is not by itself a trigger. If the user names a
reviewer, use ordinary `agenthub dispatch --agent ...` so that agent performs the review directly;
do not replace the user's choice with the persisted review route.

When one of the conditions above holds, do not choose the reviewer or model manually. Dispatch
through the requester-specific route and retain the run ID:

```sh
agenthub review dispatch \
  --requester codex \
  --cwd "$PWD" \
  --prompt "Review the current PR and report actionable findings with severity."
agenthub wait RUN_ID
```

Use the current CLI's stable ID as `--requester`: `codex`, `claude-code`, or `kimi-code`. Cockpit may
change the route between reviews; `review dispatch` reads it at dispatch time and passes the saved
reviewer/model directly to the ordinary run path without querying the model catalog. If the reviewer
CLI is unavailable, report the synchronous dispatch error. If that CLI rejects a saved model after
the run is created, inspect the run's terminal error. Do not choose a fallback. Use
`review status --cwd "$PWD"` only when the effective route needs to be shown or diagnosed.

When Agent Hub has already selected the current process as the reviewer, perform the review directly
in the current session; do not invoke `agenthub review dispatch` again.

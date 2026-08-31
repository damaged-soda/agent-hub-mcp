# Structured Discussion

Put the complete Discussion request in a private JSON file, then dispatch it:

```sh
agenthub discussion dispatch --json-file /absolute/path/discussion.json
agenthub discussion wait DISCUSSION_ID
```

The detached worker continues after dispatch exits. Repeat `discussion wait` after a timeout. Use
`discussion query` for a snapshot and `discussion cancel` only on explicit cancellation.

New requests may set `budget_profile` to `quick` (30 minutes), `standard` (60 minutes, default), or
`research` (90 minutes). Use quick for bounded review with little tool work, standard for ordinary
repository design/review, and research only for work that explicitly needs experiments or
cross-repository investigation. Follow-ups inherit the parent profile. Inspect `budget_status`
before attributing a missed repair or phase deadline to the provider.

Use this to find retained records without resuming them:

```sh
agenthub discussion list --status completed,failed --since 7d --cwd "$PWD"
```

Treat `completion_quality: partial` as an incomplete protocol even when `status` is `completed`. On
failure, inspect `failure_summary.last_cause` and `phase_statistics` before opening linked run
artifacts.

# Pull request review

When a PR or change review is governed by the machine review policy, do not choose the reviewer or
model manually. Dispatch through the requester-specific route and retain the run ID:

```sh
agenthub review dispatch \
  --requester codex \
  --cwd "$PWD" \
  --prompt "Review the current PR and report actionable findings with severity."
agenthub wait RUN_ID
```

Use the current CLI's stable ID as `--requester`: `codex`, `claude-code`, or `kimi-code`. Cockpit may
change the route between reviews; `review dispatch` reads and validates it at dispatch time. If the
configured reviewer or model is unavailable, report the failure instead of choosing a fallback.
Use `review status --cwd "$PWD"` only when the effective route needs to be shown or diagnosed.

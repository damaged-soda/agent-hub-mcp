---
name: agent-hub
description: Dispatch and coordinate local Claude Code, Codex, Kimi Code, and OpenCode processes through the daemon-free agenthub CLI, run isolated repository coding-agent evaluations, and resolve copied agenthub:// session or event references. Use when Codex needs another coding agent to review, investigate, implement, compare conclusions, evaluate code navigation, continue or inspect a native CLI session, resolve an Agent Hub reference, or participate in a durable structured discussion.
---

# Agent Hub

Use `agenthub` as the stable interface. Commands run in the caller's current login and Keychain
context; do not start the HTTP daemon for ordinary collaboration.

## Route the task

Read only the reference for the requested workflow:

- PR or change review governed by the machine review route:
  [references/reviews.md](references/reviews.md).
- Ordinary dispatch, implementation, investigation, continuation, or structured run input:
  [references/runs.md](references/runs.md).
- A single repository navigation or patch evaluation:
  [references/evals.md](references/evals.md). For a controlled baseline/candidate structural
  comparison, use the separate `eval-driven-refactor` Skill as well.
- A copied `agenthub://session/v1/...` reference or native session inspection:
  [references/sessions.md](references/sessions.md).
- A durable structured Discussion:
  [references/discussions.md](references/discussions.md).

## Shared invariants

- Keep Agent Hub `run_id` values separate from provider-native session IDs.
- Never place credential values in prompts or metadata, and never persist transcript bodies or send
  them to third parties.
- Inspect JSON `status`, `error`, and artifacts; successful CLI transport does not mean the agent
  run completed successfully.
- A wait timeout is not a failure. Query or wait again, and cancel only when the user asks to stop.
- If `agenthub` is unavailable, report that the local package needs `npm run install:local` from the
  Agent Hub repository. Do not silently fall back to another agent mechanism.

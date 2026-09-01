---
name: agent-hub
description: Dispatch explicitly selected local Claude Code, Codex, Kimi Code, and OpenCode CLI processes through the daemon-free agenthub CLI; run Agent Hub evaluations, session inspection, reference resolution, routed review, and durable Discussion workflows. Use only when the user explicitly requests Agent Hub, selects a named external coding-agent CLI or provider, invokes an Agent Hub-specific workflow, or the post-PR policy requires routed cross-review. Agent Hub is a supplementary cross-provider perspective, not a replacement for a host's native subagent or multi-agent mechanism; generic subagent, delegation, parallelization, and unspecified-agent requests are outside this Skill's scope.
---

# Agent Hub

Agent Hub is a supplementary cross-provider transport, not a replacement for the host's native
subagent or multi-agent mechanism. Ordinary dispatch requires explicit Agent Hub intent or a named
external coding-agent CLI or provider. Generic subagent, delegation, parallelization, and
unspecified-agent requests are outside this Skill's scope.

For in-scope workflows, use `agenthub` as the stable interface. Commands run in the caller's current
login and Keychain context; do not start the HTTP daemon for ordinary collaboration.

## Route the task

Read only the reference for the requested workflow:

- A post-PR machine-routed cross-review, immediately after this process successfully creates or
  updates a PR, or an explicit request to use Agent Hub's configured review route:
  [references/reviews.md](references/reviews.md).
- Ordinary dispatch explicitly requested through Agent Hub or addressed to a named external
  coding-agent CLI or provider, including implementation, investigation, continuation, or
  structured run input. A review prompt addressed to the current process is direct work:
  [references/runs.md](references/runs.md).
- A single repository navigation or patch evaluation:
  [references/evals.md](references/evals.md). For a controlled baseline/candidate structural
  comparison, use the separate `eval-driven-refactor` Skill as well.
- A copied `agenthub://session/v1/...` reference or native session inspection:
  [references/sessions.md](references/sessions.md).
- A durable structured Discussion:
  [references/discussions.md](references/discussions.md).

## Shared invariants

- `agenthub review dispatch` is only for the post-PR machine-policy step described above, or for an
  explicit user request to use Agent Hub's configured review route. Do not infer this route merely
  from words such as PR, change, diff, or review. If the user names another agent, use ordinary
  dispatch to that agent and preserve the user's choice.
- If Agent Hub has already selected this process as the reviewer, perform the review directly and
  do not dispatch another review.
- Keep Agent Hub `run_id` values separate from provider-native session IDs.
- Never place credential values in prompts or metadata, and never persist transcript bodies or send
  them to third parties.
- Inspect JSON `status`, `error`, and artifacts; successful CLI transport does not mean the agent
  run completed successfully.
- A wait timeout is not a failure. Query or wait again, and cancel only when the user asks to stop.
- If `agenthub` is unavailable, report that the local package needs `npm run install:local` from the
  Agent Hub repository. Do not silently fall back to another agent mechanism.

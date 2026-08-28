---
name: agent-hub
description: Dispatch and coordinate local Claude Code, Codex, Kimi Code, and OpenCode processes through the daemon-free agenthub CLI, and resolve copied agenthub:// session or event references. Use when Codex needs another coding agent to review, investigate, implement, compare conclusions, continue or inspect a native CLI session, resolve an Agent Hub reference, or participate in a durable structured discussion.
---

# Agent Hub

Use `agenthub` as the stable interface. Each command runs in the caller's current login and Keychain context; do not start the HTTP daemon for ordinary collaboration.

## Review a pull request

When the task is a PR or change review governed by the machine review policy, do not choose the
reviewer or model manually. Dispatch through the requester-specific route and retain the run ID:

```sh
agenthub review dispatch \
  --requester codex \
  --cwd "$PWD" \
  --prompt "Review the current PR and report actionable findings with severity."
agenthub wait RUN_ID
```

Use the current CLI's stable agent ID as `--requester`: `codex`, `claude-code`, `kimi-code`, or
`opencode`. Cockpit may change the route between reviews; `review dispatch` reads and validates it
at dispatch time. If the configured reviewer or model is unavailable, report the failure instead
of choosing a fallback. Use `review status --cwd "$PWD"` only when the effective route needs to be
shown or diagnosed.

## Dispatch work

1. Discover available agents in the target workspace:

   ```sh
   agenthub agents --cwd "$PWD"
   ```

2. Dispatch the task and retain both `run_ref.run_id` and `cli_session_ref`:

   ```sh
   agenthub dispatch \
     --agent claude-code \
     --cwd "$PWD" \
     --prompt "Review the current changes and report actionable findings only."
   ```

3. Wait with the same run ID:

   ```sh
   agenthub wait RUN_ID
   ```

If a wait result has `timed_out: true`, call `agenthub wait RUN_ID` again. Do not treat a timeout as failure and do not cancel unless the user asks to stop.

Use `agenthub run` only for short tasks. Prefer `dispatch` plus `wait` for reviews, investigations, and edits.

## Continue a session

Pass the native session ID returned by the previous run:

```sh
agenthub dispatch \
  --agent claude-code \
  --cwd "$PWD" \
  --session-id NATIVE_SESSION_ID \
  --prompt "Re-check the revised implementation."
```

Keep Agent Hub `run_id` values separate from native session IDs.

## Resolve a copied session reference

Treat a user-supplied `agenthub://session/v1/...` value as an opaque reference. Do not parse,
rewrite, or guess its components. Resolve it through the stable read CLI:

```sh
agent-session resolve 'agenthub://session/v1/PROVIDER/SESSION_ID'
agent-session resolve 'agenthub://session/v1/PROVIDER/SESSION_ID/event/EVENT_ID'
```

Directly sending the reference authorizes inspection of its complete provider-native session. The
session form returns stable identity and metadata; the event form additionally returns a bounded
inspect diagnostic containing the exact target, its paired tool call/result when present, and the
effective context at that step. Start there, then read only the additional pages needed for the task:

```sh
agent-session inspect --provider PROVIDER --session-id SESSION_ID \
  --profile inspect --after SEQUENCE --limit 200
```

You may inspect the whole session when useful without asking again, but do not eagerly load it when
the bounded diagnostic is sufficient. Never persist transcript bodies or send them to third parties.
If resolution reports a stale reference, report that exact failure; do not substitute a similar
event.

## Supply structured input

Use `--json` for complete run inputs and `--json-file` for large or complex inputs. Use `--prompt-file -` to read a prompt from stdin. Adapter-specific metadata takes precedence over unified metadata.

```sh
agenthub dispatch --json '{
  "agent_id": "claude-code",
  "cwd": "/absolute/project/path",
  "prompt": "Review the change.",
  "metadata": {"claude": {"model": "sonnet"}}
}'
```

Never place credential values in prompts or metadata.

## Run a structured discussion

Put the complete Discussion request in a private JSON file, then dispatch it:

```sh
agenthub discussion dispatch --json-file /absolute/path/discussion.json
agenthub discussion wait DISCUSSION_ID
```

The detached Discussion worker continues after the dispatch command exits. Repeat `discussion wait` after a timeout. Use `discussion query` for a snapshot and `discussion cancel` only on explicit cancellation.

## Handle failures

- Inspect the JSON `status`, `error`, and artifact list; successful CLI transport does not imply the agent run completed successfully.
- Use `agenthub query RUN_ID` before deciding a detached run was lost.
- If `agenthub` is unavailable, report that the local package needs `npm run install:local` from the Agent Hub repository. Do not silently fall back to a different agent mechanism.

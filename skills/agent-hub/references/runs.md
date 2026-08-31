# Dispatch and continue runs

## Dispatch work

First discover available agents in the target workspace:

```sh
agenthub agents --cwd "$PWD"
```

Then dispatch the task and retain both `run_ref.run_id` and `cli_session_ref`:

```sh
agenthub dispatch \
  --agent claude-code \
  --cwd "$PWD" \
  --prompt "Review the current changes and report actionable findings only."
agenthub wait RUN_ID
```

If a wait result has `timed_out: true`, call `agenthub wait RUN_ID` again. Use `agenthub run` only
for short tasks. Prefer `dispatch` plus `wait` for reviews, investigations, and edits.

## Continue a native session

Pass the native session ID returned by the previous run:

```sh
agenthub dispatch \
  --agent claude-code \
  --cwd "$PWD" \
  --session-id NATIVE_SESSION_ID \
  --prompt "Re-check the revised implementation."
```

A continuation creates a new Agent Hub run while resuming the provider-native session.

## Supply structured input

Use `--json` for complete run inputs, `--json-file` for large or complex inputs, and
`--prompt-file -` to read a prompt from stdin. Adapter-specific metadata takes precedence over
unified metadata.

```sh
agenthub dispatch --json '{
  "agent_id": "claude-code",
  "cwd": "/absolute/project/path",
  "prompt": "Review the change.",
  "metadata": {"claude": {"model": "sonnet"}}
}'
```

Use `agenthub query RUN_ID` before deciding a detached run was lost.

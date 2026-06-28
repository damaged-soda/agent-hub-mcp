# Agent Hub MCP Integration Guide

This guide is for MCP clients that want to call local agent CLIs through Agent Hub MCP. Agent Hub is a stdio MCP server; clients launch `src/server.js` and call tools with JSON arguments.

## Server Registration

```json
{
  "mcpServers": {
    "agent_hub": {
      "command": "node",
      "args": ["/absolute/path/to/agent-hub-mcp/src/server.js"]
    }
  }
}
```

The server currently exposes the `claude-code` adapter when `claude --version` succeeds and reports Claude Code.

## Typical Flow

1. Call `list_agents`.
2. Call `run_agent` for simple blocking execution, or call `dispatch_to_agent` and then poll with `query_agent_run` / `wait_agent_run`.
3. Keep the returned `cli_session_ref` if the next request should resume the same Claude Code session.
4. Use `cancel_agent_run` with `run_ref` to stop a still-running local process group.

## Tools

### list_agents

No input. Returns available and unavailable local adapters.

### run_agent

Dispatches a run and waits until it reaches a terminal state or the timeout expires.

```json
{
  "agent_id": "claude-code",
  "prompt": "Review the current diff.",
  "cwd": "/absolute/path/to/project",
  "cli_session_ref": null,
  "metadata": {
    "claude": {
      "model": "sonnet",
      "effort": "medium"
    }
  },
  "timeout_ms": 600000,
  "poll_interval_ms": 1000
}
```

Important request rules:

- `agent_id` must be `claude-code`.
- `prompt` is passed to Claude Code through stdin without wrapper text.
- `cwd` must be an existing absolute directory.
- `timeout_ms` defaults to `600000` and is capped at `3600000`.
- `poll_interval_ms` defaults to `1000`.

If the wait times out while the run is still active, the response has `status: "running"` and `timed_out: true`; keep the `run_ref` and call `wait_agent_run` again.

### dispatch_to_agent

Starts a run and returns immediately:

```json
{
  "status": "accepted",
  "run_ref": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "cli_session_ref": {
    "agent_id": "claude-code",
    "native_session_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "poll_after_ms": 1000
}
```

### query_agent_run

Reads the latest snapshot:

```json
{
  "run_ref": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

Running snapshots can include `log_tail`. Terminal snapshots include `content`, `artifacts`, and possibly `error`.

### wait_agent_run

Blocks on an existing run:

```json
{
  "run_ref": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "timeout_ms": 600000,
  "poll_interval_ms": 1000
}
```

### cancel_agent_run

Requests cancellation of the run process group:

```json
{
  "run_ref": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

## Claude Metadata

`metadata.claude` maps to Claude Code CLI flags:

| Field | CLI flag | Notes |
|---|---|---|
| `model` | `--model` | Optional non-empty string. |
| `effort` | `--effort` | Optional non-empty string. |
| `agent` | `--agent` | Optional non-empty string. |
| `permission_mode` | `--permission-mode` | Defaults to `auto`. |
| `add_dirs` | `--add-dir` | Array of directories resolved and allowlist-checked before execution. |

Supported `permission_mode` values are `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, and `plan`. Normal integrations should omit the field and let Agent Hub pass `auto`.

## Session Continuation

For a new session, pass `cli_session_ref: null`. Agent Hub creates a UUID and passes it to Claude Code as `--session-id`.

To continue, pass back the previous terminal response's `cli_session_ref`:

```json
{
  "agent_id": "claude-code",
  "native_session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Agent Hub then calls Claude Code with `--resume <native_session_id>`.

## Artifacts

Responses can include artifacts stored inside the run directory:

- `request.json`
- `command.json`
- `stdout.log`
- `stderr.log`
- `runner.log`
- `result.json`
- `result.txt`

`content[0].text` is read from `result.txt` for terminal runs.

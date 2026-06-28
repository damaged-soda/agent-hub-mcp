# Agent Hub MCP Operator Runbook

This runbook covers local operation of Agent Hub MCP.

## Prerequisites

- Node.js 20 or newer.
- Dependencies installed with `npm install`.
- Claude Code CLI available as `claude`.
- Claude Code authentication configured through environment variables or the CLI's own config.

Validate the adapter:

```sh
claude --version
node scripts/mcp-client.js list_agents
```

`list_agents` returns `claude-code` under `agents` only when the local CLI is available.

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Start the MCP stdio server. |
| `npm test` | Run the Vitest suite. |
| `npm run selftest:mcp` | Call the local server through `scripts/mcp-client.js`. |
| `npm run review:self` | Ask Claude Code to review this repository through Agent Hub. |

## Environment Variables

| Variable | Default | Operational use |
|---|---|---|
| `AGENT_HUB_RUN_DIR` | `$XDG_CACHE_HOME/agent-hub-mcp/runs` or `~/.cache/agent-hub-mcp/runs` | Moves run state, logs, and artifacts. |
| `AGENT_HUB_RUN_TTL_SECONDS` | `604800` | Retention for terminal runs. Must be a non-negative number. |
| `AGENT_HUB_CWD_ALLOWLIST` | unset | Path-delimited allowlist for request `cwd` and Claude `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | unset | Comma-separated extra environment variable names to forward to the agent CLI. |

The runner forwards a small default environment allowlist for Claude auth, cloud auth, terminal behavior, `PATH`, user directories, and XDG paths. Add project-specific keys by setting `AGENT_HUB_FORWARD_ENV` on the MCP server process, for example:

```sh
AGENT_HUB_FORWARD_ENV=FOO_TOKEN,BAR_PROFILE node src/server.js
```

`command.json` records only selected environment key names after redacting sensitive-looking keys; it does not record environment values.

## Run Storage

Each run gets its own `0700` directory under the run root:

```text
state.json
request.json
command.json
input.txt
stdout.log
stderr.log
runner.log
result.txt
result.json
```

Terminal runs are removed after `expires_at`. Cleanup runs at the start of `list_agents`, `dispatch_to_agent`, `query_agent_run`, `wait_agent_run`, and `run_agent`.

## Smoke Test

Use a temporary run directory when verifying behavior:

```sh
AGENT_HUB_RUN_DIR=/tmp/agent-hub-runs node scripts/mcp-client.js run_agent --json '{
  "agent_id": "claude-code",
  "prompt": "Reply with OK.",
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
}'
```

Inspect `structuredContent.status`, `structuredContent.content`, and the run's `command.json` if the result is unexpected.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `claude-code` appears under `unavailable_agents` | `claude --version` failed or did not report Claude Code. | Fix PATH or Claude Code installation. |
| `cwd must be an absolute path` | Request used a relative working directory. | Send an absolute existing directory. |
| `outside AGENT_HUB_CWD_ALLOWLIST` | `cwd` or `add_dirs` is outside the configured allowlist. | Add the project root to `AGENT_HUB_CWD_ALLOWLIST` or change the request path. |
| `status: "running"` with `timed_out: true` | Wait timeout expired while the CLI was still running. | Call `wait_agent_run` again with the same `run_ref`, or cancel. |
| `process_missing` | Active state existed but the runner or CLI process was gone. | Inspect `runner.log`, `stderr.log`, and `command.json`. |
| `stdout_parse_failed` | Claude stdout was not valid JSON for print mode. | Inspect `stdout.log` and `stderr.log`; verify the adapter command in `command.json`. |
| Permission prompts or edit approval friction | The request used a restrictive Claude permission mode. | Omit `metadata.claude.permission_mode`; Agent Hub defaults to `auto`. |

## Cancellation

`cancel_agent_run` marks the run cancelled and starts a detached canceller. The canceller sends SIGTERM to the stored process group, waits 10 seconds, then sends SIGKILL if the group is still alive. This process-group behavior targets macOS/Linux.

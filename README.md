# Agent Hub MCP

Agent Hub MCP is a local MCP stdio bridge for running agent CLIs from MCP tools. The first adapter targets Claude Code and runs it in non-interactive print mode while Agent Hub owns run state, logs, waiting, cancellation, and local artifact storage.

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- Claude Code CLI available as `claude`.
- Claude Code authentication configured through its normal CLI environment.

Install dependencies:

```sh
npm install
```

Run the test suite:

```sh
npm test
```

List available adapters through the local MCP client:

```sh
node scripts/mcp-client.js list_agents
```

Run a smoke prompt:

```sh
node scripts/mcp-client.js run_agent --json '{
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

`cwd` must be an existing absolute directory. If `metadata.claude.permission_mode` is omitted, Agent Hub passes `--permission-mode auto` to Claude Code.

## MCP Server

The server runs on stdio:

```sh
npm start
```

MCP clients should launch the server process, for example:

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

The exposed tools are:

- `list_agents`
- `dispatch_to_agent`
- `query_agent_run`
- `wait_agent_run`
- `cancel_agent_run`
- `run_agent`

## Configuration

| Variable | Purpose |
|---|---|
| `AGENT_HUB_RUN_DIR` | Override the run storage root. |
| `AGENT_HUB_RUN_TTL_SECONDS` | Override terminal run retention; default is `604800`. |
| `AGENT_HUB_CWD_ALLOWLIST` | Optional path-delimited allowlist for `cwd` and Claude `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | Comma-separated extra environment variable names forwarded to the agent CLI. |

Run directories are stored under `$XDG_CACHE_HOME/agent-hub-mcp/runs` or `~/.cache/agent-hub-mcp/runs` by default and are created with `0700` permissions.

## Docs

- [Architecture](docs/architecture.md) explains run/session boundaries, state files, process groups, and adapter behavior.
- [Integration guide](docs/integration-guide.md) shows how MCP clients should call the tools.
- [Operator runbook](docs/operator-runbook.md) covers configuration, smoke tests, storage, and troubleshooting.

## Development

Useful commands:

```sh
npm test
npm run selftest:mcp
npm run review:self
```

This repository currently targets macOS/Linux process-group semantics for cancellation.

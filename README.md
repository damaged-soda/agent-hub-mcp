# Agent Hub MCP

Agent Hub MCP is a local MCP stdio bridge for running agent CLIs from MCP tools. It ships three adapters — Claude Code (`claude-code`), Codex CLI (`codex`), and Kimi Code (`kimi-code`) — and runs them in non-interactive mode while Agent Hub owns run state, logs, waiting, cancellation, and local artifact storage.

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- Claude Code CLI available as `claude`, Codex CLI available as `codex`, and/or Kimi Code CLI available as `kimi`.
- CLI authentication configured through each CLI's normal environment (`claude` login, `codex login` or `OPENAI_API_KEY`, `kimi` login under `KIMI_CODE_HOME`).

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

Dispatch a smoke prompt:

```sh
node scripts/mcp-client.js dispatch_to_agent --json '{
  "agent_id": "claude-code",
  "prompt": "Reply with OK.",
  "cwd": "/absolute/path/to/project",
  "cli_session_ref": null,
  "metadata": {
    "claude": {
      "model": "sonnet",
      "effort": "medium"
    }
  }
}'
```

The same flow works for Codex with `"agent_id": "codex"` and `metadata.codex`, and for Kimi Code with `"agent_id": "kimi-code"` and `metadata["kimi-code"]` (see the [integration guide](docs/integration-guide.md)). For a new Codex or Kimi session the dispatch response has `cli_session_ref: null`; the session id appears on the terminal snapshot once the CLI reports it.

Use the returned `run_ref` with `wait_agent_run` until the run reaches a terminal state. The server waits up to 10 minutes by default; if the MCP client times out first, keep the `run_ref` and call `query_agent_run` or `wait_agent_run` again. `run_agent` is still available for short tasks that should finish inside the MCP client's tool timeout.

`cwd` must be an existing absolute directory. Unified top-level metadata fields (`model`, `permission`, `add_dirs`) work for all adapters; the default `permission: "auto"` maps to `--permission-mode auto` for Claude Code, `--sandbox workspace-write` with network access for Codex, and kimi `-p`'s built-in auto approval for Kimi Code (kimi has no permission flags in prompt mode, so `read-only`/`full` are rejected there rather than silently remapped). Adapter namespaces (`metadata.claude`, `metadata.codex`, `metadata["kimi-code"]`) override the unified fields; effort stays adapter-native (`metadata.<adapter>.effort`, or the `AGENT_HUB_*_EFFORT` server defaults).

## MCP Server

The server runs on stdio:

```sh
npm start
```

It can also run as a long-lived local streamable HTTP daemon:

```sh
node src/server.js --transport streamable-http --host 127.0.0.1 --port 8700 --path /mcp
```

The HTTP transport is intended for local loopback use only. The server rejects non-loopback hosts and does not implement remote authentication.

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
| `AGENT_HUB_CWD_ALLOWLIST` | Optional path-delimited allowlist for `cwd` and adapter `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | Comma-separated extra environment variable names forwarded to the agent CLI. |
| `AGENT_HUB_CLAUDE_MODEL` | Default `--model` for Claude runs when `metadata.claude.model` is not provided; keeps runs independent of the locally saved Claude Code default model. |
| `AGENT_HUB_CODEX_MODEL` | Default `--model` for Codex runs when `metadata.codex.model` is not provided. |
| `AGENT_HUB_CLAUDE_EFFORT` | Default `--effort` for Claude runs when `metadata.claude.effort` is not provided. |
| `AGENT_HUB_CODEX_EFFORT` | Default `model_reasoning_effort` for Codex runs when `metadata.codex.effort` is not provided. |
| `AGENT_HUB_KIMI_MODEL` | Default `-m` for Kimi runs when `metadata["kimi-code"].model` is not provided. |
| `AGENT_HUB_KIMI_EFFORT` | Default `KIMI_MODEL_THINKING_EFFORT` for Kimi runs when `metadata["kimi-code"].effort` is not provided. |

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

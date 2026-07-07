# Agent Hub MCP Operator Runbook

This runbook covers local operation of Agent Hub MCP.

## Prerequisites

- Node.js 20 or newer.
- Dependencies installed with `npm install`.
- Claude Code CLI available as `claude` and/or Codex CLI available as `codex`.
- CLI authentication configured through environment variables or each CLI's own config (`claude` login; `codex login` or `OPENAI_API_KEY`, honoring `CODEX_HOME`).

Validate the adapters:

```sh
claude --version
codex --version
node scripts/mcp-client.js list_agents
```

`list_agents` returns `claude-code` and `codex` under `agents` only when the corresponding local CLI is available; missing CLIs appear under `unavailable_agents`.

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
| `AGENT_HUB_CWD_ALLOWLIST` | unset | Path-delimited allowlist for request `cwd` and adapter `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | unset | Comma-separated extra environment variable names to forward to the agent CLI. |
| `AGENT_HUB_CLAUDE_MODEL` | unset | Default `--model` for Claude runs when the request omits `metadata.claude.model`. Without it, the Claude CLI falls back to the locally saved default model. |
| `AGENT_HUB_CODEX_MODEL` | unset | Default `--model` for Codex runs when the request omits `metadata.codex.model`. |
| `AGENT_HUB_CLAUDE_EFFORT` | unset | Default `--effort` for Claude runs when the request omits `metadata.claude.effort`. |
| `AGENT_HUB_CODEX_EFFORT` | unset | Default `model_reasoning_effort` for Codex runs when the request omits `metadata.codex.effort`. |

The runner forwards a small default environment allowlist for Claude and Codex auth (`ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), cloud auth, terminal behavior, `PATH`, user directories, and XDG paths. Add project-specific keys by setting `AGENT_HUB_FORWARD_ENV` on the MCP server process, for example:

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
AGENT_HUB_RUN_DIR=/tmp/agent-hub-runs node scripts/mcp-client.js dispatch_to_agent --json '{
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

For Codex, use `"agent_id": "codex"` with `metadata.codex`, for example `{"codex": {"effort": "medium"}}`. A new Codex dispatch returns `cli_session_ref: null`; the thread id shows up on later snapshots.

Use the returned `run_ref` with `wait_agent_run`, or with `query_agent_run` when you only need the latest snapshot. Inspect `structuredContent.status`, `structuredContent.content`, `progress_events`, and the run's `command.json` if the result is unexpected.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `claude-code` appears under `unavailable_agents` | `claude --version` failed or did not report Claude Code. | Fix PATH or Claude Code installation. |
| `codex` appears under `unavailable_agents` | `codex --version` failed. | Fix PATH or Codex CLI installation. |
| `agent_error` | The agent CLI reported a model-side failure (Claude `is_error`, Codex `turn.failed`: auth, model, or execution error). | Read `result.txt` and `events.jsonl`; check the CLI's login status and the requested model. |
| `cwd must be an absolute path` | Request used a relative working directory. | Send an absolute existing directory. |
| `outside AGENT_HUB_CWD_ALLOWLIST` | `cwd` or `add_dirs` is outside the configured allowlist. | Add the project root to `AGENT_HUB_CWD_ALLOWLIST` or change the request path. |
| `status: "running"` with `timed_out: true` | Agent Hub's wait window expired while the CLI was still running. | Call `query_agent_run` or `wait_agent_run` again with the same `run_ref`; cancel only if the user wants to stop it. |
| `process_missing` | Active state existed but the runner or CLI process was gone. | Inspect `runner.log`, `stderr.log`, and `command.json`. |
| `stdout_parse_failed` | CLI stdout did not contain the expected JSON/JSONL result events. | Inspect `stdout.log` and `stderr.log`; verify the adapter command in `command.json`. |
| Permission prompts or edit approval friction | The request used a restrictive Claude permission mode. | Omit `metadata.claude.permission_mode`; Agent Hub defaults to `auto`. |

## Cancellation

`cancel_agent_run` marks the run cancelled, records optional `reason` and `actor` fields, and starts a detached canceller. The canceller sends SIGTERM to the stored process group, waits 10 seconds, then sends SIGKILL if the group is still alive. This process-group behavior targets macOS/Linux.

# Agent Instructions

## Collaboration Routing

- When the user asks to collaborate with another agent, use the configured `agent_hub` MCP by default.
- For Claude Code collaboration, call `mcp__agent_hub.list_agents` and then dispatch to the `claude-code` agent with `mcp__agent_hub.dispatch_to_agent`.
- Do not use Codex `multi_agent_v1` sub-agents unless the user explicitly asks for Codex sub-agents or `agent_hub` is unavailable.

## Project Shape

This repository implements a local MCP stdio bridge. It maps MCP tool calls to non-interactive Claude Code CLI runs and stores run state, logs, and artifacts on the local filesystem.

Key files:

| Path | Purpose |
|---|---|
| `src/server.js` | MCP stdio server and tool schemas. |
| `src/runs.js` | Tool behavior, run lifecycle, waiting, cancellation, snapshots. |
| `src/runner.js` | Detached runner that launches Claude Code and writes terminal results. |
| `src/claude-adapter.js` | Claude Code argv/session/result mapping. |
| `src/fs-store.js` | Run storage, atomic writes, TTL cleanup, state locks. |
| `src/security.js` | `cwd` and `add_dirs` validation. |
| `src/env.js` | Environment allowlist and forwarding. |
| `scripts/mcp-client.js` | Local MCP smoke-test client. |

## Commands

```sh
npm test
npm run selftest:mcp
npm run review:self
```

Use Node.js 20 or newer. The server is `npm start` / `node src/server.js`.

## Behavioral Rules

- Preserve prompt pass-through: do not prepend wrapper prompts, system prompts, or result-file instructions to user input.
- Keep `run_id` and `cli_session_ref.native_session_id` separate. A continuation creates a new run and resumes the CLI session.
- `cwd` must remain an explicit absolute directory from the request; `metadata.claude.add_dirs` must resolve through `src/security.js`.
- Leave the default Claude permission behavior as `--permission-mode auto`. Do not use `bypassPermissions` in examples, defaults, or self-review paths unless the user explicitly asks.
- Keep process cancellation scoped to the recorded process group for the run.
- Keep run directories and state/log artifacts private (`0700` directories, `0600` files where applicable).
- Do not record environment variable values in command metadata.

## Environment Variables

| Variable | Meaning |
|---|---|
| `AGENT_HUB_RUN_DIR` | Override run storage root. |
| `AGENT_HUB_RUN_TTL_SECONDS` | Terminal run retention; default is `604800`. |
| `AGENT_HUB_CWD_ALLOWLIST` | Optional path-delimited allowlist for `cwd` and `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | Comma-separated extra env keys forwarded to Claude Code. |

## Documentation Map

| Document | Use when |
|---|---|
| `README.md` | Installing, smoke testing, or wiring the MCP server into a client. |
| `docs/integration-guide.md` | Implementing a client call flow or understanding request/response shapes. |
| `docs/operator-runbook.md` | Operating, configuring, or troubleshooting local runs. |
| `docs/architecture.md` | Changing lifecycle, storage, adapter, or process-group behavior. |

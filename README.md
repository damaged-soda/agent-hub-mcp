# Agent Hub

Agent Hub runs local agent CLIs and durable multi-agent discussions without requiring a resident daemon. Its primary interface is the `agenthub` CLI plus the bundled Codex Skill. It ships three adapters — Claude Code (`claude-code`), Codex CLI (`codex`), and Kimi Code (`kimi-code`) — and owns run state, session lineage, logs, waiting, cancellation, and local artifacts. An MCP server remains available as an optional compatibility surface.

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- Claude Code CLI available as `claude`, Codex CLI available as `codex`, and/or Kimi Code CLI available as `kimi`.
- CLI authentication configured through each CLI's normal environment (`claude` login, `codex login` or `OPENAI_API_KEY`, `kimi` login under `KIMI_CODE_HOME`).

Install dependencies, the local CLI, and the Skill:

```sh
npm install
npm run install:local
```

`npm run install:local` links `agenthub` and `agent-session` into the active npm prefix and installs the
versioned Skill at `${CODEX_HOME:-~/.codex}/skills/agent-hub`.

Run the test suite:

```sh
npm test
```

List available adapters in the current workspace:

```sh
agenthub agents --cwd "$PWD"
```

`list_agents` includes the selectable model catalog reported by each available CLI. Pass
an absolute `cwd` when model availability depends on workspace-specific authentication or
settings:

```sh
agenthub agents --cwd /absolute/path/to/project
```

Each agent has a normalized `models` array and a `model_discovery` status. Model discovery
is best-effort: if a CLI cannot return its catalog, the agent remains available and reports
`model_discovery.status: "unavailable"` with an empty `models` array.

## Inspect native sessions

`agent-session` is a separate read-only CLI for provider-native Claude Code, Codex, and Kimi Code
sessions, including sessions that were not launched by Agent Hub:

```sh
agent-session list --limit 20
agent-session inspect --provider codex --session-id SESSION_ID --limit 200
agent-session inspect --provider codex --session-id SESSION_ID --profile inspect --limit 200
agent-session serve --host 127.0.0.1 --port 8765
```

`inspect` defaults to the content-free `metadata` profile. The explicit `inspect` profile includes
visible prompts, assistant text, tool arguments, and tool results, but never projects thinking
blocks. Both commands only read provider-native files; they do not run cleanup, repair state, probe
models, launch agents, or create another session database.

`serve` hosts the same contract and a dependency-free browser UI. It rejects non-loopback binds,
foreign browser origins, and mutating HTTP methods; every API and asset response is `no-store` and
uses a restrictive Content Security Policy. The page starts in `metadata` mode and requires an
inline second confirmation before requesting transcript bodies.

Dispatch a smoke prompt:

```sh
agenthub dispatch \
  --agent claude-code \
  --cwd /absolute/path/to/project \
  --metadata '{"claude":{"model":"sonnet","effort":"medium"}}' \
  --prompt 'Reply with OK.'
```

The same flow works for Codex with `"agent_id": "codex"` and `metadata.codex`, and for Kimi Code with `"agent_id": "kimi-code"` and `metadata["kimi-code"]` (see the [integration guide](docs/integration-guide.md)). For a new Codex or Kimi session the dispatch response has `cli_session_ref: null`; the session id appears on the terminal snapshot once the CLI reports it.

Use the returned `run_ref.run_id` with `agenthub wait RUN_ID` until the run reaches a terminal state. If a wait times out, keep the run ID and wait again. `agenthub run` is available for short tasks.

Every CLI invocation inherits the caller's login, environment, and macOS Keychain context. The dispatch command exits after creating a detached runner; later `query`, `wait`, and `cancel` commands reopen the same private on-disk state, so no Agent Hub daemon has to remain alive.

`cwd` must be an existing absolute directory. Unified top-level metadata fields (`model`, `permission`, `add_dirs`) work for all adapters; the default `permission: "auto"` maps to `--permission-mode auto` for Claude Code, `--sandbox workspace-write` with network access for Codex, and kimi `-p`'s built-in auto approval for Kimi Code (kimi has no permission flags in prompt mode, so `read-only`/`full` are rejected there rather than silently remapped). Adapter namespaces (`metadata.claude`, `metadata.codex`, `metadata["kimi-code"]`) override the unified fields; effort stays adapter-native (`metadata.<adapter>.effort`, or the `AGENT_HUB_*_EFFORT` environment defaults).

Agent Hub does not resolve namespaces. It forwards the caller's session-axis state whole
（`NS`、`NS_UNDO`、`PATH`…）, sets `NS_REBIND=1`, and starts the agent CLI through
`zsh -c 'exec …'` at the run `cwd`, so `~/.zshenv`（charter's glue）unloads the inherited
domain and binds by `cwd`——exactly as a command typed in a terminal there would.

## Structured Discussions

Create a Discussion request JSON file and dispatch it from the CLI:

```sh
agenthub discussion dispatch --json-file /absolute/path/discussion.json
agenthub discussion wait DISCUSSION_ID
```

Discussion dispatch starts a detached coordinator that survives the dispatching CLI process.
Query and wait commands restart recovery on demand if an earlier coordinator disappeared. A normal
discussion runs the fixed five-phase protocol: independent memo, moderation, challenge, revision,
and synthesis.

## Optional MCP Server

MCP clients may still launch an ephemeral stdio server for the six run tools:

```sh
npm start
```

The optional streamable HTTP daemon exposes both run and Discussion tools:

```sh
node src/server.js --transport streamable-http --host 127.0.0.1 --port 8700 --path /mcp
```

The HTTP transport is intended for local loopback compatibility only; the server rejects non-loopback hosts and does not implement remote authentication. Requests without an `Origin` header are accepted for native MCP clients; browser-originated requests are rejected unless the exact origin is listed in `AGENT_HUB_HTTP_ALLOWED_ORIGINS`. Prefer the CLI/Skill path when inheriting the caller's credential context matters.

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

Both transports expose the original run tools:

- `list_agents`
- `dispatch_to_agent`
- `query_agent_run`
- `wait_agent_run`
- `cancel_agent_run`
- `run_agent`

Streamable HTTP additionally exposes:

- `dispatch_discussion`
- `query_discussion`
- `wait_discussion`
- `cancel_discussion`

For example, with the HTTP daemon running:

```sh
node scripts/mcp-client.js dispatch_discussion --url http://127.0.0.1:8700/mcp --json '{
  "kind": "new",
  "objective": "Choose an implementation approach",
  "question": "Which option should we ship?",
  "cwd": "/absolute/path/to/project",
  "materials": [],
  "host": {"agent_id": "claude-code", "metadata": {}},
  "participants": [
    {"participant_id": "reviewer-a", "agent_id": "codex", "role": "reliability reviewer", "focus": "recovery and races", "metadata": {}},
    {"participant_id": "reviewer-b", "agent_id": "kimi-code", "role": "product reviewer", "focus": "usability and scope", "metadata": {}}
  ],
  "quorum": 2
}'
```

The caller chooses the host and complete participant roster before dispatch. The coordinator then runs the five-phase protocol. After completion, a follow-up may add a question and new materials but keeps the original roster. Discussion permissions come from adapter capabilities: Claude/Codex currently prefer read-only and Kimi uses auto. This is best-effort only, not a security boundary.

## Configuration

| Variable | Purpose |
|---|---|
| `AGENT_HUB_RUN_DIR` | Override the run storage root. |
| `AGENT_HUB_RUN_TTL_SECONDS` | Override terminal run retention; default is `604800`. |
| `AGENT_HUB_DISCUSSION_DIR` | Override Discussion storage; by default it is a `discussions` sibling of the run root. |
| `AGENT_HUB_DISCUSSION_TTL_SECONDS` | Override terminal Discussion retention; defaults to `AGENT_HUB_RUN_TTL_SECONDS` or `604800`. |
| `AGENT_HUB_HTTP_ALLOWED_ORIGINS` | Comma-separated exact browser origins allowed to call the loopback HTTP daemon; unset rejects requests carrying `Origin`. |
| `AGENT_HUB_CWD_ALLOWLIST` | Optional path-delimited allowlist for `cwd` and adapter `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | Comma-separated extra environment variable names forwarded to the agent CLI. |
| `AGENT_HUB_CLAUDE_MODEL` | Default `--model` for Claude runs when `metadata.claude.model` is not provided; keeps runs independent of the locally saved Claude Code default model. |
| `AGENT_HUB_CODEX_MODEL` | Default `--model` for Codex runs when `metadata.codex.model` is not provided. |
| `AGENT_HUB_CLAUDE_EFFORT` | Default `--effort` for Claude runs when `metadata.claude.effort` is not provided. |
| `AGENT_HUB_CODEX_EFFORT` | Default `model_reasoning_effort` for Codex runs when `metadata.codex.effort` is not provided. |
| `AGENT_HUB_KIMI_MODEL` | Default `-m` for Kimi runs when `metadata["kimi-code"].model` is not provided. |
| `AGENT_HUB_KIMI_EFFORT` | Default `KIMI_MODEL_THINKING_EFFORT` for Kimi runs when `metadata["kimi-code"].effort` is not provided. |

Run directories are stored under `$XDG_CACHE_HOME/agent-hub-mcp/runs` or `~/.cache/agent-hub-mcp/runs` by default and are created with `0700` permissions. Discussion records are stored in the sibling `discussions` directory and retain linked run artifacts for the same seven-day terminal TTL.

## Docs

- [Agent Session Core](docs/agent-session-core.md) defines the provider-neutral session identity,
  provenance model, and content projection boundary shared with future inspectors and telemetry
  consumers.
- [Architecture](docs/architecture.md) explains run/session boundaries, state files, process groups, and adapter behavior.
- [Discussion feature design](docs/discussion-design.md) specifies the durable, structured multi-agent discussion workflow and its invariants.
- [Integration guide](docs/integration-guide.md) documents the CLI and optional MCP surfaces.
- [Operator runbook](docs/operator-runbook.md) covers configuration, smoke tests, storage, and troubleshooting.

## Development

Useful commands:

```sh
npm test
npm run cli -- --help
npm run selftest:mcp
npm run review:self
```

This repository currently targets macOS/Linux process-group semantics for cancellation.

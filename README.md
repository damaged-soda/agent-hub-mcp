# Agent Hub

Agent Hub runs local agent CLIs and durable multi-agent discussions without requiring a resident daemon. Its primary interface is the `agenthub` CLI plus the bundled Codex Skill. It ships four adapters — Claude Code (`claude-code`), Codex CLI (`codex`), Kimi Code (`kimi-code`), and OpenCode (`opencode`) — and owns run state, session lineage, logs, waiting, cancellation, and local artifacts. An MCP server remains available as an optional compatibility surface.

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- Claude Code CLI available as `claude`, Codex CLI available as `codex`, Kimi Code CLI available as `kimi`, and/or OpenCode CLI available as `opencode`.
- CLI authentication configured through each CLI's normal environment (`claude` login, `codex login` or `OPENAI_API_KEY`, `kimi` login under `KIMI_CODE_HOME`, `opencode auth login`).

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

`agent-session` is a separate read-only CLI for provider-native Claude Code, Codex, Kimi Code, and OpenCode
sessions, including sessions that were not launched by Agent Hub:

```sh
agent-session list --limit 20
agent-session inspect --provider codex --session-id SESSION_ID --limit 200
agent-session inspect --provider codex --session-id SESSION_ID --profile inspect --limit 200
agent-session inspect --provider opencode --session-id SESSION_ID --profile inspect --limit 200
agent-session resolve 'agenthub://session/v1/codex/SESSION_ID'
agent-session resolve 'agenthub://session/v1/codex/SESSION_ID/event/EVENT_ID'
agent-session serve --host 127.0.0.1 --port 8765
agent-session serve --host 127.0.0.1 --port 8765 \
  --public-origin https://cockpit.example.ts.net --base-path /agent-session
```

`inspect` defaults to the body-free `metadata` profile. The explicit `inspect` profile includes
visible prompts, assistant text, tool arguments, tool results, and per-step high-confidence file /
Skill accesses, but never projects thinking blocks. Long inspect fields are bounded and carry
truncation metadata. These commands only read provider-native files; they do not run cleanup, repair
state, probe models, launch agents, or create another session database.
OpenCode discovery and inspect read its provider-native SQLite database through
`sqlite3 -readonly -json`; they exclude reasoning and never launch OpenCode or issue a model request.
The `sqlite3` command is required only when an OpenCode database exists.

Native sessions and transcript events include stable `agenthub://session/v1/...` references that
exclude file paths, machine location, and display sequence. `resolve` validates either form; session
references return metadata, while event references add a bounded inspect diagnostic with the exact
target, its paired tool call/result when present, and the effective context at that step. Stale event
references fail instead of drifting to a similar event.

Metadata omits command and message bodies but may retain normalized resource paths derived from
explicit file operands so the exact read/write step remains auditable. Shell writes are not inferred;
only structured write tools and patch headers currently produce write accesses.

`serve` hosts the same read-only JSON contract for Cockpit. It rejects non-loopback binds, foreign
browser origins, and mutating HTTP methods; every response is `no-store`. Its root returns a
versioned service description, `/healthz` is a side-effect-free liveness endpoint, and UI assets
remain a Cockpit responsibility.
`--public-origin` adds one exact HTTPS Host/Origin pair for a trusted loopback reverse proxy such as
Tailscale Serve; it never changes the loopback-only bind.
`--base-path` moves the service description, health check, and API together under one canonical
prefix; root remains the default, and the prefix without its trailing slash redirects to the
canonical URL.

The session server has no authentication of its own. `--public-origin` is routing validation,
not authorization: the reverse proxy and its network policy are the only access-control boundary,
and callers can request `?profile=inspect` directly. Cockpit must require an explicit user action
before making that request. Use the server only behind
an access-controlled private proxy such as tailnet-only Tailscale Serve; never place it behind
Tailscale Funnel or another public tunnel. Bind addresses are intentionally limited to the literal
`127.0.0.1` and `::1`; `localhost` is rejected rather than resolved.

Dispatch a smoke prompt:

```sh
agenthub dispatch \
  --agent claude-code \
  --cwd /absolute/path/to/project \
  --metadata '{"claude":{"model":"sonnet","effort":"medium"}}' \
  --prompt 'Reply with OK.'
```

The same flow works for Codex with `"agent_id": "codex"` and `metadata.codex`, Kimi Code with `"agent_id": "kimi-code"` and `metadata["kimi-code"]`, and OpenCode with `"agent_id": "opencode"` and `metadata.opencode` (see the [integration guide](docs/integration-guide.md)). For a new Codex, Kimi, or OpenCode session the dispatch response has `cli_session_ref: null`; the session id appears on a later snapshot once the CLI reports it.

Use the returned `run_ref.run_id` with `agenthub wait RUN_ID` until the run reaches a terminal state. If a wait times out, keep the run ID and wait again. `agenthub run` is available for short tasks.

For PR cross-review, use the persisted requester route instead of choosing an adapter ad hoc:

```sh
agenthub review status --cwd "$PWD"
agenthub review set --requester codex --reviewer kimi-code \
  --model kimi-code/k3 --cwd "$PWD"
agenthub review dispatch --requester codex --cwd "$PWD" \
  --prompt "Review the current PR and report actionable findings with severity."
```

`review set` accepts only a reviewer and model present in the live `agents` catalog, rejects
self-review, and atomically stores overrides in
`${XDG_CONFIG_HOME:-~/.config}/agent-hub-mcp/review-routing.json`. With no override, Codex uses
Claude Code's `default` model (currently resolved by Claude Code to Opus 5); Claude Code and Kimi
Code use Codex `gpt-5.6-sol`. `review dispatch` revalidates the configured route and fails
instead of silently falling back when either the reviewer or model is unavailable. Its response is
the ordinary detached run response, so waiting and inspection remain unchanged.

Every CLI invocation inherits the caller's login, environment, and macOS Keychain context. The dispatch command exits after creating a detached runner; later `query`, `wait`, and `cancel` commands reopen the same private on-disk state, so no Agent Hub daemon has to remain alive.

`cwd` must be an existing absolute directory. Unified `model` and `permission` metadata map through every adapter; `add_dirs` maps only where the target CLI exposes an additional-directory boundary (OpenCode rejects non-empty values). The default `permission: "auto"` maps to `--permission-mode auto` for Claude Code, `--sandbox workspace-write` with network access for Codex, kimi `-p`'s built-in auto approval, and OpenCode `--auto`. OpenCode treats `--auto` like its yolo mode for asked permissions and provides no workspace filesystem boundary; only explicit deny rules remain enforced. Kimi and OpenCode reject `read-only`/`full` rather than silently remapping them. Adapter namespaces (`metadata.claude`, `metadata.codex`, `metadata["kimi-code"]`, `metadata.opencode`) override unified fields; effort stays adapter-native (`metadata.<adapter>.effort`, or the `AGENT_HUB_*_EFFORT` environment defaults).

Agent Hub does not resolve namespaces. It forwards the caller's session-axis state whole
（`NS`、`NS_UNDO`、`PATH`…）, sets `NS_REBIND=1`, and starts the agent CLI through
`zsh -c 'exec …'` at the run `cwd`, so `~/.zshenv`（charter's glue）unloads the inherited
domain and binds by `cwd`——exactly as a command typed in a terminal there would.

## Structured Discussions

Create a Discussion request JSON file and dispatch it from the CLI:

```sh
agenthub discussion dispatch --json-file /absolute/path/discussion.json
agenthub discussion wait DISCUSSION_ID
agenthub discussion list --status completed,failed --since 7d --cwd "$PWD"
```

Discussion dispatch starts a detached coordinator that survives the dispatching CLI process.
Query and wait commands restart recovery on demand if an earlier coordinator disappeared. A normal
discussion runs the fixed five-phase protocol: independent memo, moderation, challenge, revision,
and synthesis.

`discussion list` scans retained local records without starting or resuming them. It can filter by
status, age, and exact working directory. Query and wait snapshots expose
`completion_quality` (`complete`, `partial`, or `failed` when applicable), per-phase coverage and
timing, plus a bounded `failure_summary` that preserves the concrete failed turn/attempt behind a
terminal error.

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

The caller chooses the host and complete participant roster before dispatch. The coordinator then runs the five-phase protocol. After completion, a follow-up may add a question and new materials but keeps the original roster. Discussion permissions come from adapter capabilities: Claude/Codex currently prefer read-only, while Kimi/OpenCode use auto. This is best-effort only, not a security boundary.

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
| `AGENT_HUB_REVIEW_CONFIG` | Override the review-routing JSON path; defaults to `${XDG_CONFIG_HOME:-~/.config}/agent-hub-mcp/review-routing.json`. |
| `AGENT_HUB_CLAUDE_MODEL` | Default `--model` for Claude runs when `metadata.claude.model` is not provided; keeps runs independent of the locally saved Claude Code default model. |
| `AGENT_HUB_CODEX_MODEL` | Default `--model` for Codex runs when `metadata.codex.model` is not provided. |
| `AGENT_HUB_CLAUDE_EFFORT` | Default `--effort` for Claude runs when `metadata.claude.effort` is not provided. |
| `AGENT_HUB_CODEX_EFFORT` | Default `model_reasoning_effort` for Codex runs when `metadata.codex.effort` is not provided. |
| `AGENT_HUB_KIMI_MODEL` | Default `-m` for Kimi runs when `metadata["kimi-code"].model` is not provided. |
| `AGENT_HUB_KIMI_EFFORT` | Default `KIMI_MODEL_THINKING_EFFORT` for Kimi runs when `metadata["kimi-code"].effort` is not provided. |
| `AGENT_HUB_OPENCODE_MODEL` | Default `--model` for OpenCode runs when `metadata.opencode.model` is not provided. |
| `AGENT_HUB_OPENCODE_EFFORT` | Default `--variant` for OpenCode runs when `metadata.opencode.effort` is not provided. |

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

# Agent Instructions

## Collaboration Routing

- When the user asks to collaborate with another agent, use the `agenthub` CLI through the bundled `agent-hub` Skill by default.
- For Claude Code collaboration, run `agenthub agents --cwd "$PWD"`, then `agenthub dispatch --agent claude-code …` and retain the run ID for `agenthub wait`.
- Do not use Codex `multi_agent_v1` sub-agents unless the user explicitly asks for Codex sub-agents or `agenthub` is unavailable. The optional `agent_hub` MCP is a compatibility fallback, not the primary route.

## Project Shape

This repository implements a daemon-free Agent Hub CLI and Skill, plus optional MCP compatibility transports. It maps requests to non-interactive agent CLI runs (Claude Code, Codex, and Kimi Code), stores local artifacts, and coordinates durable structured discussions.

Key files:

| Path | Purpose |
|---|---|
| `src/cli.js` | Primary `agenthub` command surface. |
| `src/server.js` | Optional MCP stdio/HTTP compatibility server. |
| `src/runs.js` | Tool behavior, run lifecycle, waiting, cancellation, snapshots. |
| `src/runner.js` | Detached runner that launches the agent CLI and writes terminal results. |
| `src/adapters.js` | Adapter registry keyed by `agent_id`. |
| `src/claude-adapter.js` | Claude Code argv/session/result mapping. |
| `src/codex-adapter.js` | Codex CLI argv/session/result mapping. |
| `src/kimi-adapter.js` | Kimi Code argv/session/result mapping. |
| `src/adapter-utils.js` | Shared adapter helpers (metadata assertions, version probe). |
| `src/agent-session-core.js` | Provider-neutral session identity, provenance, and pure live-event projections. |
| `src/agent-session-references.js` | Versioned stable native-event URI formatting, identity, and parsing. |
| `src/agent-session-transcripts.js` | Pure Claude/Codex/Kimi native transcript projections. |
| `src/agent-session-resources.js` | Pure high-confidence file/Skill access extraction for session tool steps. |
| `src/agent-session-sources.js` | Side-effect-free native session discovery and cursor reads. |
| `src/session-cli.js` | Read-only `agent-session list/inspect/serve` command surface. |
| `src/session-server.js` | Loopback-only no-store session API for Cockpit. |
| `src/fs-store.js` | Run storage, atomic writes, TTL cleanup, state locks. |
| `src/session-registry.js` | Cross-run session leases, generations, and lineage claims. |
| `src/discussion-manager.js` | Durable five-phase Discussion coordinator and recovery controller. |
| `src/discussion-cli.js` | CLI Discussion dispatch, passive query/wait/cancel, and worker startup. |
| `src/discussion-worker.js` | Detached per-Discussion coordinator process. |
| `src/discussion-protocol.js` | Discussion input/output schemas, limits, and provenance validation. |
| `src/discussion-store.js` | Discussion events, projections, leases, artifacts, and TTL cleanup. |
| `src/discussion-materials.js` | Frozen material bundles, file validation, hashing, and handoff data. |
| `src/discussion-prompts.js` | Versioned turn and format-repair prompts. |
| `src/discussion-render.js` | Deterministic DecisionRecord Markdown rendering. |
| `src/security.js` | `cwd` and `add_dirs` validation. |
| `src/env.js` | Environment allowlist and forwarding. |
| `scripts/mcp-client.js` | Local MCP smoke-test client. |
| `skills/agent-hub/` | Versioned Codex Skill for CLI collaboration workflows. |

## Commands

```sh
npm test
npm run install:local
npm run cli -- --help
npm run selftest:mcp
npm run review:self
```

Use Node.js 20 or newer. Prefer `agenthub`; `npm start` and streamable HTTP are optional MCP compatibility surfaces.

## Behavioral Rules

- Preserve prompt pass-through for ordinary run tools: do not prepend wrapper prompts, system prompts, or result-file instructions to user input. Discussion turns use only the versioned coordinator templates in `src/discussion-prompts.js`.
- Keep `run_id` and `cli_session_ref.native_session_id` separate. A continuation creates a new run and resumes the CLI session.
- Codex assigns its own thread id: a new `codex` run dispatches with `cli_session_ref: null` and the runner backfills it from the first `thread.started` event.
- Kimi assigns its own session id and reports it only in the final `session.resume_hint` event: a new `kimi-code` run dispatches with `cli_session_ref: null` and the ref appears on the terminal snapshot.
- `cwd` must remain an explicit absolute directory from the request; `metadata.claude.add_dirs`, `metadata.codex.add_dirs`, and `metadata["kimi-code"].add_dirs` must resolve through `src/security.js`.
- Unified metadata (`metadata.model` / `permission` / `add_dirs`) maps to native flags per adapter; the adapter namespaces (`metadata.claude.*`, `metadata.codex.*`, `metadata["kimi-code"].*`) take precedence. Effort is adapter-native only (`metadata.<adapter>.effort`, falling back to `AGENT_HUB_CLAUDE_EFFORT` / `AGENT_HUB_CODEX_EFFORT` / `AGENT_HUB_KIMI_EFFORT`) because each CLI has its own value vocabulary. Model-side failures use the unified error code `agent_error`.
- The default unified permission is `auto`: `--permission-mode auto` for Claude, `--sandbox workspace-write` plus `network_access=true` for Codex, and kimi `-p`'s built-in auto approval for Kimi Code (kimi prompt mode takes no permission flags; unified `read-only`/`full` are rejected rather than remapped). Do not use `permission: "full"`, `bypassPermissions`, `danger-full-access`, or `--dangerously-bypass-approvals-and-sandbox` in examples, defaults, or self-review paths unless the user explicitly asks.
- Keep process cancellation scoped to the recorded process group for the run.
- Keep run directories and state/log artifacts private (`0700` directories, `0600` files where applicable).
- Do not record environment variable values in command metadata.

## Environment Variables

| Variable | Meaning |
|---|---|
| `AGENT_HUB_RUN_DIR` | Override run storage root. |
| `AGENT_HUB_RUN_TTL_SECONDS` | Terminal run retention; default is `604800`. |
| `AGENT_HUB_DISCUSSION_DIR` | Override Discussion storage root. |
| `AGENT_HUB_DISCUSSION_TTL_SECONDS` | Terminal Discussion retention; default follows run TTL. |
| `AGENT_HUB_HTTP_ALLOWED_ORIGINS` | Exact comma-separated browser origins allowed to call the loopback HTTP daemon. |
| `AGENT_HUB_CWD_ALLOWLIST` | Optional path-delimited allowlist for `cwd` and `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | Comma-separated extra env keys forwarded to the agent CLI. |
| `AGENT_HUB_CLAUDE_MODEL` | Default model for Claude runs. |
| `AGENT_HUB_CODEX_MODEL` | Default model for Codex runs. |
| `AGENT_HUB_CLAUDE_EFFORT` | Default effort for Claude runs. |
| `AGENT_HUB_CODEX_EFFORT` | Default effort for Codex runs. |
| `AGENT_HUB_KIMI_MODEL` | Default model for Kimi runs. |
| `AGENT_HUB_KIMI_EFFORT` | Default effort for Kimi runs. |

## Workspace Namespace

Agent Hub **does not resolve, derive or scrub namespaces**（2026-08-22；the direnv-era
probe/overlay was removed）. Charter's session axis binds a domain only when a process is
born through a shell, via glue, and session-axis state must be inherited whole（charter
E7: selective forwarding makes the same-domain fast path skip evaluation and silently
lose material variables）. So the runner (1) forwards the caller's session-axis state whole
（`NS`、`NS_UNDO`、`PATH`、`GH_CONFIG_DIR`、`BASH_ENV`）, (2) sets `NS_REBIND=1`, and (3)
starts the agent CLI as `/bin/zsh -c 'exec "$0" "$@"'` at the run `cwd`: `~/.zshenv`
（glue → `ns-resolve`）unloads the inherited domain via `NS_UNDO`（even the same domain——
this re-fills material variables the allowlist dropped）, then binds by `cwd`; no domain at
`cwd` means unload only. The hub knows nothing about domains. A `cwd` outside any domain
is not rejected: the agent runs namespace-less（charter's `gh` wrapper 点名 the missing
`GH_CONFIG_DIR`）.

## Documentation Map

| Document | Use when |
|---|---|
| `README.md` | Installing, smoke testing, or wiring the CLI/Skill and optional MCP server. |
| `docs/integration-guide.md` | Implementing a client call flow or understanding request/response shapes. |
| `docs/operator-runbook.md` | Operating, configuring, or troubleshooting local runs. |
| `docs/architecture.md` | Changing lifecycle, storage, adapter, or process-group behavior. |
| `docs/agent-session-core.md` | Changing provider-neutral session/event projections or content profiles. |
| `docs/discussion-design.md` | Changing the fixed Discussion protocol, schemas, recovery, or safety boundaries. |

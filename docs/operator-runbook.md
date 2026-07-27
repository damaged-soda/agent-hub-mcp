# Agent Hub Operator Runbook

This runbook covers the daemon-free CLI/Skill path and the optional MCP server.

## Prerequisites

- Node.js 20 or newer.
- Dependencies installed with `npm install`.
- Claude Code CLI available as `claude`, Codex CLI available as `codex`, and/or Kimi Code CLI available as `kimi`.
- CLI authentication configured through environment variables or each CLI's own config (`claude` login; `codex login` or `OPENAI_API_KEY`, honoring `CODEX_HOME`; `kimi` login, honoring `KIMI_CODE_HOME`).

Validate the adapters:

```sh
claude --version
codex --version
kimi --version
agenthub agents --cwd "$PWD"
```

`agenthub agents` returns `claude-code`, `codex`, and `kimi-code` under `agents` only when the corresponding local CLI is available; missing CLIs appear under `unavailable_agents`.
It also returns the selectable model catalog for each adapter. Use
`--json '{"cwd":"/absolute/path/to/project"}'` when the CLI configuration or authentication
namespace depends on the target workspace. A model catalog failure is reported through
`model_discovery` and does not move the adapter to `unavailable_agents`.

## Commands

| Command | Purpose |
|---|---|
| `npm run install:local` | Link the `agenthub` CLI and install the bundled Codex Skill. |
| `agenthub agents --cwd "$PWD"` | Discover adapters and models in the caller's workspace context. |
| `agenthub dispatch …` / `agenthub wait RUN_ID` | Run long work without a resident daemon. |
| `agenthub discussion dispatch …` / `agenthub discussion wait ID` | Run a durable Discussion through an on-demand detached coordinator. |
| `npm start` | Start the optional MCP stdio compatibility server. |
| `node src/server.js --transport streamable-http --host 127.0.0.1 --port 8700 --path /mcp` | Start the optional loopback HTTP compatibility daemon. |
| `npm test` | Run the Vitest suite. |
| `npm run selftest:mcp` | Call the local server through `scripts/mcp-client.js`. |
| `npm run review:self` | Ask Claude Code to review this repository through Agent Hub. |

## Environment Variables

| Variable | Default | Operational use |
|---|---|---|
| `AGENT_HUB_RUN_DIR` | `$XDG_CACHE_HOME/agent-hub-mcp/runs` or `~/.cache/agent-hub-mcp/runs` | Moves run state, logs, and artifacts. |
| `AGENT_HUB_RUN_TTL_SECONDS` | `604800` | Retention for terminal runs. Must be a non-negative number. |
| `AGENT_HUB_DISCUSSION_DIR` | sibling `discussions` directory next to the run root | Moves Discussion state, events, materials, prompts, and decisions. |
| `AGENT_HUB_DISCUSSION_TTL_SECONDS` | `AGENT_HUB_RUN_TTL_SECONDS` or `604800` | Retention for terminal Discussions and their linked runs. |
| `AGENT_HUB_HTTP_ALLOWED_ORIGINS` | unset | Comma-separated exact browser origins allowed to call the loopback daemon. Native MCP clients normally send no `Origin`; browser origins are rejected by default. |
| `AGENT_HUB_CWD_ALLOWLIST` | unset | Path-delimited allowlist for request `cwd` and adapter `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | unset | Comma-separated extra environment variable names to forward to the agent CLI. |
| `AGENT_HUB_CLAUDE_MODEL` | unset | Default `--model` for Claude runs when the request omits `metadata.claude.model`. Without it, the Claude CLI falls back to the locally saved default model. |
| `AGENT_HUB_CODEX_MODEL` | unset | Default `--model` for Codex runs when the request omits `metadata.codex.model`. |
| `AGENT_HUB_CLAUDE_EFFORT` | unset | Default `--effort` for Claude runs when the request omits `metadata.claude.effort`. |
| `AGENT_HUB_CODEX_EFFORT` | unset | Default `model_reasoning_effort` for Codex runs when the request omits `metadata.codex.effort`. |
| `AGENT_HUB_KIMI_MODEL` | unset | Default `-m` for Kimi runs when the request omits `metadata["kimi-code"].model`. |
| `AGENT_HUB_KIMI_EFFORT` | unset | Default `KIMI_MODEL_THINKING_EFFORT` for Kimi runs when the request omits `metadata["kimi-code"].effort`. |
| `AGENT_HUB_REQUIRE_NAMESPACE` | unset | Set to `1`, `true`, or `yes` to reject a cwd whose direnv namespace is missing or incomplete instead of clearing redirects and using default config roots. |

The runner forwards a small default environment allowlist for Claude, Codex, and Kimi auth/routing (`ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME`), namespace Git/GitHub routing (`GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR`), cloud auth, terminal behavior, `PATH`, user directories, and XDG paths. CLI calls inherit the caller's process and Keychain context before applying this allowlist. Add project-specific keys with `AGENT_HUB_FORWARD_ENV`, for example:

```sh
AGENT_HUB_FORWARD_ENV=FOO_TOKEN,BAR_PROFILE agenthub dispatch …
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

The run root also contains private `.internal/idempotency` and `.internal/sessions` indexes. Do not edit or delete them while a detached runner, Discussion worker, or optional daemon is active. Discussion directories are siblings of the run root by default:

```text
discussions/<discussion-id>/
  request.json
  state.json
  events.jsonl
  lease.json
  materials/
  prompts/
  handoff/
  decision.json
  decision.md
```

Only terminal Discussions are TTL-cleaned. Linked run state records carry `retain_until`, so their raw CLI artifacts remain available for the Discussion retention window.

## Smoke Test

Use a temporary run directory when verifying behavior:

```sh
AGENT_HUB_RUN_DIR=/tmp/agent-hub-runs agenthub dispatch --json '{
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

For Codex, use `"agent_id": "codex"` with `metadata.codex`, for example `{"codex": {"effort": "medium"}}`. For Kimi Code, use `"agent_id": "kimi-code"` with `metadata["kimi-code"]`. A new Codex or Kimi dispatch returns `cli_session_ref: null`; the session id shows up on later snapshots.

Use the returned run ID with `agenthub wait RUN_ID`, or `agenthub query RUN_ID` when you only need the latest snapshot. Inspect `status`, `content`, `progress_events`, and the run's `command.json` if the result is unexpected.

## Discussion Smoke Test

Prepare a request file, then use the CLI with an isolated store:

```sh
AGENT_HUB_RUN_DIR=/tmp/agent-hub-runs \
AGENT_HUB_DISCUSSION_DIR=/tmp/agent-hub-discussions \
agenthub discussion dispatch --json-file /absolute/path/discussion.json
```

Pass the returned ID to `agenthub discussion wait DISCUSSION_ID`. A normal two-participant discussion creates eight runs. Do not treat one `timed_out: true` response as failure; repeat the wait with the same ID.

The dispatch command exits after its detached Discussion worker accepts the request. Query, wait, and cancel commands trigger recovery when the record is nonterminal; the lease prevents two workers from coordinating the same Discussion. After an unclean worker exit, allow the 20-second lease staleness window before expecting a replacement worker to acquire it.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `claude-code` appears under `unavailable_agents` | `claude --version` failed or did not report Claude Code. | Fix PATH or Claude Code installation. |
| `codex` appears under `unavailable_agents` | `codex --version` failed. | Fix PATH or Codex CLI installation. |
| `kimi-code` appears under `unavailable_agents` | `kimi --version` failed. | Fix PATH or Kimi Code CLI installation. |
| `agent_error` | The agent CLI reported a model-side failure (Claude `is_error`, Codex `turn.failed`, kimi `failed to run prompt`: auth, model, or execution error). | Read `result.txt` and `events.jsonl`; check the CLI's login status and the requested model. |
| `namespace_unresolved` | `AGENT_HUB_REQUIRE_NAMESPACE` is enabled, but the run cwd did not yield all namespace redirect variables through direnv. | Restore/allow the workspace `.envrc`; for managed Codex worktrees rerun the namespace's `install-<ns>-codex-environment`. |
| `cwd must be an absolute path` | Request used a relative working directory. | Send an absolute existing directory. |
| `outside AGENT_HUB_CWD_ALLOWLIST` | `cwd` or `add_dirs` is outside the configured allowlist. | Add the project root to `AGENT_HUB_CWD_ALLOWLIST` or change the request path. |
| `status: "running"` with `timed_out: true` | Agent Hub's wait window expired while the CLI was still running. | Call `query_agent_run` or `wait_agent_run` again with the same `run_ref`; cancel only if the user wants to stop it. |
| `process_missing` | Active state existed but the runner or CLI process was gone. | Inspect `runner.log`, `stderr.log`, and `command.json`. |
| `stdout_parse_failed` | CLI stdout did not contain the expected JSON/JSONL result events. | Inspect `stdout.log` and `stderr.log`; verify the adapter command in `command.json`. |
| `session_busy` | Another run currently owns the same CLI session. | Wait for or cancel the active run; do not retry concurrently. |
| `session_generation_conflict` / `session_reserved` | A continuation or sibling follow-up tried to fork an already advanced lineage. | Start a fresh session; Discussion follow-ups rebuild from handoff automatically. |
| `discussion_lease_held` | Another Discussion worker or optional HTTP daemon currently owns that Discussion. | Keep one coordinator per store entry, or wait at least 20 seconds after an unclean owner loss. |
| `protocol_integrity: degraded` | Quorum was met, but a participant missed or failed a later formal turn. | Inspect participant statuses and `events.jsonl`; the DecisionRecord may still be valid. |
| Discussion `failed` with `quorum_not_met`, `moderation_failed`, or `decision_failed` | The fixed protocol could not produce the required formal record. | Inspect linked run artifacts and structured validation errors; start a new Discussion after correcting inputs/config. |
| Permission prompts or edit approval friction | The request used a restrictive Claude permission mode. | Omit `metadata.claude.permission_mode`; Agent Hub defaults to `auto`. |

## Cancellation

`agenthub cancel RUN_ID` marks the run cancelled, records optional `reason` and `actor` fields, and starts a detached canceller. The canceller sends SIGTERM to the stored process group, waits 10 seconds, then sends SIGKILL if the group is still alive. This process-group behavior targets macOS/Linux.

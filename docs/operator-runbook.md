# Agent Hub Operator Runbook

This runbook covers the daemon-free CLI/Skills path and the optional MCP server.

## Prerequisites

- Node.js 20 or newer.
- Dependencies installed with `npm install`.
- Claude Code CLI available as `claude`, Codex CLI available as `codex`, Kimi Code CLI available as `kimi`, and/or OpenCode CLI available as `opencode`.
- CLI authentication configured through environment variables or each CLI's own config (`claude` login; `codex login` or `OPENAI_API_KEY`, honoring `CODEX_HOME`; `kimi` login, honoring `KIMI_CODE_HOME`; `opencode auth login`).

Validate the adapters:

```sh
claude --version
codex --version
kimi --version
opencode --version
agenthub agents --cwd "$PWD"
```

`agenthub agents` returns `claude-code`, `codex`, `kimi-code`, and `opencode` under `agents` only when the corresponding local CLI is available; missing CLIs appear under `unavailable_agents`.
It also returns the selectable model catalog for each adapter. Use
`--json '{"cwd":"/absolute/path/to/project"}'` to probe from a specific working directory
（it does not select a namespace）. A model catalog failure is reported through
`model_discovery` and does not move the adapter to `unavailable_agents`.

## Commands

| Command | Purpose |
|---|---|
| `npm run install:local` | Link the `agenthub` and `agent-session` CLIs; Skill discovery remains Charter-managed. |
| `agent-session list …` / `agent-session inspect …` | Read provider-native sessions without mutating them. |
| `agent-session serve --host 127.0.0.1 --port 8765` | Run the no-store local session API for Cockpit. |
| `agenthub agents --cwd "$PWD"` | Discover adapters and models in the caller's workspace context. |
| `agenthub dispatch …` / `agenthub wait RUN_ID` | Run long work without a resident daemon. |
| `agenthub eval run --agent codex --model ID --effort LEVEL --cwd "$PWD" --suite FILE` | Run one interactive suite against a clean repository commit. |
| `agenthub review status/set/dispatch …` | Inspect, change, and use the requester-specific PR review route. |
| `agenthub discussion dispatch …` / `agenthub discussion wait ID` | Run a durable Discussion through an on-demand detached coordinator. |
| `agenthub discussion list --status failed --since 7d` | Find retained Discussions without resuming them. |
| `npm start` | Start the optional MCP stdio compatibility server. |
| `node src/server.js --transport streamable-http --host 127.0.0.1 --port 8700 --path /mcp` | Start the optional loopback HTTP compatibility daemon. |
| `npm test` | Run the Vitest suite. |
| `npm run selftest:mcp` | Call the local server through `scripts/mcp-client.js`. |
| `npm run review:self` | Ask Claude Code to review this repository through Agent Hub. |

## Session Inspector Operations

`npm run install:local` links `agent-session` into the same active npm prefix as `agenthub`.
Verify the body-free metadata path before exposing a reverse proxy:

```sh
agent-session list --limit 5
agent-session inspect --provider codex --session-id SESSION_ID --profile metadata --limit 20
agent-session inspect --provider opencode --session-id SESSION_ID --profile metadata --limit 20
agent-session serve --host 127.0.0.1 --port 8765  # keep this terminal open
```

The CLI/API default to metadata. Cockpit owns the private browser page and must request bounded
`inspect` only after an explicit user action. Treat inspect responses as sensitive even though long
values are truncated.

Resolving a session reference is metadata-only; resolving an event is deliberately body-bearing and
returns the target, related event, and effective context in bounded `inspect` form:

```sh
agent-session resolve 'agenthub://session/v1/codex/SESSION_ID'
agent-session resolve 'agenthub://session/v1/codex/SESSION_ID/event/EVENT_ID'
```

From another terminal, verify the no-body path:

```sh
curl -fsS 'http://127.0.0.1:8765/api/sessions?limit=1'
```

Discovery roots follow `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `KIMI_CODE_HOME`, and
`XDG_DATA_HOME/opencode`. When that OpenCode database exists, inspector reads it with
`sqlite3 -readonly -json`; check the root, `sqlite3` executable, and OpenCode schema compatibility
when sessions do not appear. This integration is verified against OpenCode 1.18.25; schema drift is
reported through `source_errors` on aggregate lists and remains a hard error for
`--provider opencode`.

### Claude native session persistence

Agent Hub's Claude adapter requires a resumable native transcript. Before dispatch it probes
`projects/`, `session-env/`, and `sessions/` under Claude's native config root; after a successful
CLI exit it verifies that the session transcript exists. A Codex `workspace-write` profile should
grant only these state directories (plus optional directories used by Claude's checkpoints and
task tools), not the entire `~/.claude` tree:

```toml
[permissions.auto-network.filesystem]
"/Users/leavan/.claude/projects" = "write"
"/Users/leavan/.claude/session-env" = "write"
"/Users/leavan/.claude/sessions" = "write"
"/Users/leavan/.claude/file-history" = "write"
"/Users/leavan/.claude/tasks" = "write"
"/Users/leavan/.claude/shell-snapshots" = "write"
"/Users/leavan/.claude/plans" = "write"
```

If the preflight fails, `dispatch` returns `session_store_unwritable` (or
`session_persistence_disabled`) without starting Claude. If Claude exits successfully but its
transcript is missing, the run is marked `session_persistence_failed`; Agent Hub preserves the
result artifacts but removes the resumable `cli_session_ref`.

## Post-PR Review Routing

The routed review workflow is a policy step after the current process creates or updates a PR, or an
explicit user-requested Agent Hub operation. Reviewing an existing PR or diff is direct work. When a
user names another agent, use ordinary dispatch to that agent; the selected agent reviews directly.

Each initiating CLI has one effective reviewer/model pair. Inspect all routes and the effective model
catalog from a representative workspace:

```sh
agenthub review status --cwd "$PWD"
```

The first status call discovers every local CLI. Later processes read the private catalog cache:
entries are fresh for five minutes, then served stale for up to 24 hours while one detached worker
refreshes them. Inspect the top-level `catalog_cache` field to distinguish `fresh`, `stale`,
`refreshed`, and `uncached`; a failed refresh keeps the last catalog and waits 60 seconds before
retrying. `review set` and `review dispatch` bypass the display cache and validate live.

Change a route through the validated CLI; Cockpit's Agent page calls this same command rather than
writing the file directly:

```sh
agenthub review set --requester codex --reviewer kimi-code \
  --model kimi-code/k3 --cwd "$PWD"
```

The supported requester IDs are `codex`, `claude-code`, and `kimi-code`. Reviewer and
model must appear together in the current `agenthub agents` result, and reviewer must differ from
requester. OpenCode remains selectable as a reviewer; it is not a requester until the machine-level
instruction discovery chain covers it. Selecting the built-in default pair removes that requester's stored override. Corrupt
configuration, missing reviewers, and removed models remain explicit errors.

After one of the routed-review conditions above, agents dispatch through the route and keep the returned
run ID:

```sh
agenthub review dispatch --requester codex --cwd "$PWD" \
  --prompt "Review the current PR and report findings with severity."
agenthub wait RUN_ID
```

Review dispatch supplies the configured model as unified metadata and otherwise preserves the
ordinary detached-run contract. It wraps the original request in the versioned reviewer-control
prompt, records review provenance, and rejects nested review dispatch from the selected reviewer.

The server only accepts literal `127.0.0.1` or `::1` binds. To admit one private reverse-proxy
origin and mount the complete surface below a path, restart it with
`--public-origin https://exact-private-origin --base-path /agent-session`. Public-origin paths,
credentials, and HTTP origins are rejected. Wildcards are unsupported and never match a real Host.
The base path is routing, not authorization: keep authorization at the private proxy/network layer,
never use Funnel or another public tunnel, and treat direct `?profile=inspect` requests as capable
of returning transcript bodies without the UI confirmation. The service description, liveness
endpoint, and API remain below the same canonical prefix.

## Environment Variables

| Variable | Default | Operational use |
|---|---|---|
| `AGENT_HUB_RUN_DIR` | `$XDG_CACHE_HOME/agent-hub-mcp/runs` or `~/.cache/agent-hub-mcp/runs` | Moves run state, logs, and artifacts. |
| `AGENT_HUB_RUN_TTL_SECONDS` | `604800` | Retention for terminal runs. Must be a non-negative number. |
| `AGENT_HUB_EVAL_DIR` | `${XDG_STATE_HOME:-~/.local/state}/agent-hub-mcp/evals` | Moves private eval-result JSON files. |
| `AGENT_HUB_EVAL_TTL_SECONDS` | `AGENT_HUB_RUN_TTL_SECONDS` or `604800` | Retention for completed eval results. |
| `AGENT_HUB_DISCUSSION_DIR` | sibling `discussions` directory next to the run root | Moves Discussion state, events, materials, prompts, and decisions. |
| `AGENT_HUB_DISCUSSION_TTL_SECONDS` | `AGENT_HUB_RUN_TTL_SECONDS` or `604800` | Retention for terminal Discussions and their linked runs. |
| `AGENT_HUB_HTTP_ALLOWED_ORIGINS` | unset | Comma-separated exact browser origins allowed to call the loopback daemon. Native MCP clients normally send no `Origin`; browser origins are rejected by default. |
| `AGENT_HUB_CWD_ALLOWLIST` | unset | Path-delimited allowlist for request `cwd` and adapter `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | unset | Comma-separated extra environment variable names to forward to the agent CLI. |
| `AGENT_HUB_REVIEW_CONFIG` | `${XDG_CONFIG_HOME:-~/.config}/agent-hub-mcp/review-routing.json` | Moves the versioned requester → reviewer/model override file. |
| `AGENT_HUB_CATALOG_CACHE_DIR` | `${XDG_CACHE_HOME:-~/.cache}/agent-hub-mcp/agent-catalog` | Moves the private cross-process catalog cache used by `review status`. |
| `AGENT_HUB_CLAUDE_MODEL` | unset | Default `--model` for Claude runs when the request omits `metadata.claude.model`. Without it, the Claude CLI falls back to the locally saved default model. |
| `AGENT_HUB_CODEX_MODEL` | unset | Default `--model` for Codex runs when the request omits `metadata.codex.model`. |
| `AGENT_HUB_CLAUDE_EFFORT` | unset | Default `--effort` for Claude runs when the request omits `metadata.claude.effort`. |
| `AGENT_HUB_CODEX_EFFORT` | unset | Default `model_reasoning_effort` for Codex runs when the request omits `metadata.codex.effort`. |
| `AGENT_HUB_KIMI_MODEL` | unset | Default `-m` for Kimi runs when the request omits `metadata["kimi-code"].model`. |
| `AGENT_HUB_KIMI_EFFORT` | unset | Default `KIMI_MODEL_THINKING_EFFORT` for Kimi runs when the request omits `metadata["kimi-code"].effort`. |
| `AGENT_HUB_OPENCODE_MODEL` | unset | Default `--model` for OpenCode runs when the request omits `metadata.opencode.model`. |
| `AGENT_HUB_OPENCODE_EFFORT` | unset | Default `--variant` for OpenCode runs when the request omits `metadata.opencode.effort`. |

The runner forwards a small default environment allowlist for Claude, Codex, Kimi, and OpenCode auth/routing (`ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`), the session-axis state forwarded whole for charter's glue to rebind at the run cwd (`NS`, `NS_UNDO`, `GH_CONFIG_DIR`, `BASH_ENV`; `GIT_CONFIG_GLOBAL` legacy; the runner adds `NS_REBIND=1`), cloud auth, terminal behavior, `PATH`, user directories, and XDG paths. CLI calls inherit the caller's process and Keychain context before applying this allowlist. Add project-specific keys with `AGENT_HUB_FORWARD_ENV`, for example:

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

The review catalog cache is separate from run artifacts. Each cache identity gets a `0700`
directory containing an atomically replaced `0600` `catalog.json` and, only during refresh, a
short-lived `.refresh.lock`. Removing this regenerable cache is safe when no status refresh worker
is active; the next status call will synchronously rediscover local CLIs.

Detached coordinators append private JSONL diagnostics to `discussions/.workers.log`. Every record
has a timestamp, worker event, mode, PID, and a Discussion ID once one exists; rejected preflight
requests use a short-lived command ID instead. Agent Hub's structured records never contain
prompts, materials, agent output, environment values, or stacks. Unexpected runtime stderr from
Node or a dependency is outside the JSON contract and should be treated as log corruption.

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

For Codex, use `"agent_id": "codex"` with `metadata.codex`, for example `{"codex": {"effort": "medium"}}`. For Kimi Code, use `"agent_id": "kimi-code"` with `metadata["kimi-code"]`. For OpenCode, use `"agent_id": "opencode"` with `metadata.opencode`, for example `{"opencode":{"model":"zai-coding-plan/glm-5.3-flash","effort":"max"}}`. A new Codex, Kimi, or OpenCode dispatch returns `cli_session_ref: null`; the session id shows up on a later snapshot.

Use the returned run ID with `agenthub wait RUN_ID`, or `agenthub query RUN_ID` when you only need the latest snapshot. Inspect `status`, `content`, `progress_events`, and the run's `command.json` if the result is unexpected.

## Eval Smoke Test

Prepare a question-only suite anywhere readable by the foreground evaluator, verify the subject
worktree is clean, then run:

```sh
AGENT_HUB_EVAL_DIR=/tmp/agent-hub-evals \
agenthub eval run --agent codex --cwd "$PWD" \
  --suite /absolute/path/to/evals.json \
  --model gpt-5.6-sol --effort medium
```

For a schema v1 suite, the CLI must ask for `path`, `symbol`, and `definition_line` before starting
any case. Confirm the result reports `isolation.policy = "workspace-readonly/v1"`. For a schema v2
suite, supply an executable verifier outside the evaluated repository and confirm the result reports
`workspace-write/v1`, a patch digest, and verifier exit status while the original worktree remains
clean. In both modes, the backing run's `command.json` must contain `--ephemeral` and a
`permissions.agenthub-eval` inline profile, and it must not contain `--sandbox`. A non-Codex
provider or Codex older than 0.151.0 must fail with `unsupported_isolation`; do not work around
that error with a broader permission mode. Omitting `--model` or `--effort` must fail before the
first standard prompt. An external suite may change between separate eval commands, but the
normalized suite and question digests are fixed for each accepted command.

## Discussion Smoke Test

Prepare a request file, then use the CLI with an isolated store:

```sh
AGENT_HUB_RUN_DIR=/tmp/agent-hub-runs \
AGENT_HUB_DISCUSSION_DIR=/tmp/agent-hub-discussions \
agenthub discussion dispatch --json-file /absolute/path/discussion.json
```

Pass the returned ID to `agenthub discussion wait DISCUSSION_ID`. A normal two-participant discussion creates eight runs. Do not treat one `timed_out: true` response as failure; repeat the wait with the same ID.

Find recent terminal records and inspect the bounded cause before opening raw run artifacts:

```sh
agenthub discussion list --status completed,failed --since 7d --cwd "$PWD"
agenthub discussion query DISCUSSION_ID
```

Treat `completion_quality: "partial"` as a usable but incomplete protocol result. For failures,
start with `failure_summary.last_cause`; `error.code` continues to describe the terminal lifecycle
failure such as `quorum_not_met` or `decision_failed`.

Use `budget_profile: "quick"`, `"standard"`, or `"research"` in a new Discussion request. Their
hard caps are 30, 60, and 90 minutes; standard is the default. Inspect `budget_status` to distinguish
the global remaining budget, current phase remaining time, future-phase reserve, and format-repair
minimum. Follow-ups inherit the parent profile and reject attempts to override it.

The dispatch command exits after its detached Discussion worker accepts the request. Query, wait, and cancel commands trigger recovery when the record is nonterminal; the lease prevents two workers from coordinating the same Discussion. After an unclean worker exit, allow the 20-second lease staleness window before expecting a replacement worker to acquire it.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `claude-code` appears under `unavailable_agents` | `claude --version` failed or did not report Claude Code. | Fix PATH or Claude Code installation. |
| `codex` appears under `unavailable_agents` | `codex --version` failed. | Fix PATH or Codex CLI installation. |
| `kimi-code` appears under `unavailable_agents` | `kimi --version` failed. | Fix PATH or Kimi Code CLI installation. |
| `opencode` appears under `unavailable_agents` | Version probing failed or `opencode run` lacks one of the required non-interactive flags. | Install/update OpenCode and run `opencode auth login`. |
| `review status` reports `model-discovery-unavailable` | A provider CLI could not produce its model catalog, often because its state/log directory is outside the caller's sandbox. | Inspect `error_detail`, then run `agenthub agents --cwd "$PWD"` in a context where the provider's state directory is writable. |
| `nested_review_forbidden` | The current process is already an Agent Hub-selected reviewer. | Review directly in the current session; do not invoke `agenthub review dispatch` again. |
| `review status` reports stale `catalog_cache` repeatedly | Detached model discovery is failing or the cache root is not writable. | Inspect `catalog_cache.last_refresh_error`, run `agenthub agents --cwd "$PWD"`, and verify `AGENT_HUB_CATALOG_CACHE_DIR` permissions. |
| `agent_error` | The agent CLI reported a model-side failure (Claude `is_error`, Codex `turn.failed`, kimi `failed to run prompt`, or an OpenCode JSON `error` event: auth, model, or execution error). | Read `result.txt` and `events.jsonl`; check the CLI's login status and the requested model. |
| `cwd must be an absolute path` | Request used a relative working directory. | Send an absolute existing directory. |
| `outside AGENT_HUB_CWD_ALLOWLIST` | `cwd` or `add_dirs` is outside the configured allowlist. | Add the project root to `AGENT_HUB_CWD_ALLOWLIST` or change the request path. |
| `status: "running"` with `timed_out: true` | Agent Hub's wait window expired while the CLI was still running. | Call `query_agent_run` or `wait_agent_run` again with the same `run_ref`; cancel only if the user wants to stop it. |
| `process_missing` | Active state existed but the runner or CLI process was gone. | Inspect `runner.log`, `stderr.log`, and `command.json`. |
| `stdout_parse_failed` | CLI stdout did not contain the expected JSON/JSONL result events. | Inspect `stdout.log` and `stderr.log`; verify the adapter command in `command.json`. |
| `session_busy` | Another run currently owns the same CLI session. | Wait for or cancel the active run; do not retry concurrently. |
| `session_generation_conflict` / `session_reserved` | A continuation or sibling follow-up tried to fork an already advanced lineage. | Start a fresh session; Discussion follow-ups rebuild from handoff automatically. |
| `discussion_lease_held` | Another Discussion worker or optional HTTP daemon currently owns that Discussion. | Keep one coordinator per store entry, or wait at least 20 seconds after an unclean owner loss. |
| `agent-session` rejects the bind address | The host is not the literal `127.0.0.1` or `::1`. | Bind to a literal loopback address; `localhost` is intentionally rejected. |
| Inspector returns `host_forbidden` / `origin_forbidden` behind a proxy | The proxy Host/Origin differs from the exact HTTPS `--public-origin`. | Align the single private origin exactly; do not widen to a wildcard or public tunnel. |
| Inspector assets or API return 404 below a reverse-proxy path | The proxy prefix and `--base-path` differ, or the page URL omitted its canonical trailing slash. | Route the same prefix to the backend, pass the matching absolute base path, and use the redirected trailing-slash URL. |
| `protocol_integrity: degraded` | Quorum was met, but a participant missed or failed a later formal turn. | Inspect participant statuses and `events.jsonl`; the DecisionRecord may still be valid. |
| `completion_quality: partial` | The Discussion completed with a valid DecisionRecord after one or more required later turns failed. | Read `phase_statistics` and `failure_summary` before relying on the decision. |
| Discussion `failed` with `quorum_not_met`, `moderation_failed`, or `decision_failed` | The fixed protocol could not produce the required formal record. | Inspect linked run artifacts and structured validation errors; start a new Discussion after correcting inputs/config. |
| `failure_summary.last_cause.error.code: turn_deadline` | The coordinator cancelled that run at the phase deadline. Records created before this diagnostic field existed used indistinguishable `cancelled` errors. | Check `remaining_ms_at_dispatch` and the phase timing before treating it as a provider failure; old `cancelled` records cannot be classified retrospectively. |
| `failure_summary.last_cause.error.code: repair_budget_exhausted` | The first output was structurally invalid, but the phase had less than the frozen minimum repair window left. | Use a larger budget profile or reduce the turn's research scope; the coordinator deliberately did not launch a doomed repair run. |
| Permission prompts or edit approval friction | The request used a restrictive Claude permission mode. | Omit `metadata.claude.permission_mode`; Agent Hub defaults to `auto`. |

## Cancellation

`agenthub cancel RUN_ID` marks the run cancelled, records optional `reason` and `actor` fields, and starts a detached canceller. The canceller sends SIGTERM to the stored process group, waits 10 seconds, then sends SIGKILL if the group is still alive. This process-group behavior targets macOS/Linux.

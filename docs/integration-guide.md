# Agent Hub Integration Guide

The primary integration is the `agenthub` CLI. It launches from the caller's current process context, persists runs on disk, and does not require a resident daemon. The stdio and streamable HTTP MCP transports remain optional compatibility surfaces.

## CLI Registration

Install the local package and bundled Codex Skills:

```sh
npm run install:local
```

All successful CLI commands print the direct structured result as JSON. The normal long-running flow is:

```sh
agenthub agents --cwd "$PWD"
agenthub dispatch --agent claude-code --cwd "$PWD" --prompt "Review the current diff."
agenthub wait RUN_ID
```

Repository evaluations are a separate interactive CLI-only surface:

```sh
agenthub eval run --agent codex --cwd "$PWD"
```

The command discovers `.agenthub/evals.json` in a clean Git worktree, collects the human standards
through the TTY before dispatching any case, runs one fresh workspace-only Codex session per case,
and prints one `agent-eval-run` JSON document. Source-location suites use the original worktree
read-only; patch suites edit disposable detached worktrees and execute an external verifier after
the agent exits. It intentionally has no MCP tool, no prepare command, and no non-interactive
answer-file input. See [Repository evaluations](evals.md) for the suite and result contracts.

Use `--json` or `--json-file` to pass the same request objects documented below. CLI wait commands additionally accept `--timeout-ms`. A timed-out wait leaves the detached run active.

## Provider-native Session Inspector

`agent-session` is a separate read-only CLI. It discovers Claude Code, Codex, Kimi Code, and OpenCode native
sessions whether or not Agent Hub launched them:

```sh
agent-session list --limit 20
agent-session inspect --provider codex --session-id SESSION_ID
agent-session inspect --provider codex --session-id SESSION_ID \
  --profile inspect --after 0 --limit 200
agent-session inspect --provider opencode --session-id SESSION_ID \
  --profile inspect --after 0 --limit 200
agent-session resolve 'agenthub://session/v1/codex/SESSION_ID'
agent-session resolve 'agenthub://session/v1/codex/SESSION_ID/event/EVENT_ID'
agent-session serve --host 127.0.0.1 --port 8765
```

`inspect` defaults to the body-free `metadata` profile. `--profile inspect` explicitly includes
visible prompts, assistant text, tool arguments, tool results, and per-tool `resource_accesses`;
thinking blocks are never projected. Long inspect fields are bounded with explicit truncation
metadata. Discovery and reads are side-effect free: they do not mutate provider stores, repair
state, launch agents, or create another session database.
OpenCode uses `sqlite3 -readonly -json` against its existing native database. Aggregate list calls
preserve healthy providers and return `source_errors` when one source fails; an explicit provider
filter remains fail-loud.

Each discovered session has a stable `session_ref`, and each provider-native event has a stable
`event_ref`. Both omit machine and file location. Session resolution returns
`kind: "agent-session-resolution"` with identity and metadata only; event resolution returns
`kind: "agent-session-event-resolution"` with the bounded inspect target, an available paired tool
call/result, and the effective context. A missing or rewritten native event fails as stale; clients
must not substitute a similar event.

Metadata can retain normalized resource paths extracted from explicit file operands while omitting
the command body itself. Current shell adapters cover reads only; write accesses come from structured
write tools and patch headers.

The loopback server exposes the same contract:

```text
GET /
GET /healthz
GET /api/sessions?provider=&limit=
GET /api/sessions/<provider>/<native-session-id>?profile=&after=&limit=
```

Every response is `no-store`; mutating methods, foreign origins, and non-literal
loopback binds are rejected. For a trusted private reverse proxy, pass one exact HTTPS origin:

```sh
agent-session serve --host 127.0.0.1 --port 8765 \
  --public-origin https://cockpit.example.ts.net --base-path /agent-session
```

`--public-origin` only validates Host/Origin routing. The server has no authentication and the
content profile is not a server-side gate, so authorization must be enforced by the private
proxy/network policy. Never publish this endpoint through Funnel or another public tunnel.
`--base-path` places the service description, health check, and API routes below the same canonical
prefix; the default remains `/`, requests outside a configured prefix return 404, and a missing
trailing slash redirects to the canonical service URL.

## Optional MCP Server Registration

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

The server exposes the `claude-code` adapter when `claude --version` succeeds and reports Claude Code, the `codex` adapter when `codex --version` succeeds, the `kimi-code` adapter when `kimi --version` succeeds, and the `opencode` adapter when `opencode --version` is valid and `opencode run --help` exposes the required non-interactive flags.

For Codex clients, set the MCP server's `tool_timeout_sec` based on how long the host should allow a single `wait_agent_run` call to remain open. Agent Hub's server-side wait window is 10 minutes; a shorter host timeout only aborts that MCP tool call, not the background run. To let Agent Hub return its own `timed_out: true` snapshot, set the host timeout above 10 minutes:

```toml
[mcp_servers.agent_hub]
command = "node"
args = ["/absolute/path/to/agent-hub-mcp/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 660
```

## Typical Run Flow

1. Call `list_agents`.
2. For long-running or agentic work, call `dispatch_to_agent` and then `wait_agent_run`.
3. Keep the returned `cli_session_ref` if the next request should resume the same Claude Code session.
4. Use `run_agent` only for short tasks that should finish inside the MCP client's tool timeout.
5. If the MCP client times out while waiting, keep the `run_ref` and call `query_agent_run` or `wait_agent_run` again.
6. Use `cancel_agent_run` with `run_ref` to stop a still-running local process group only when the user explicitly asks to stop or the run is no longer needed.

## Tools

### list_agents

Returns available and unavailable local adapters together with their selectable models.
The optional `cwd` must be an absolute directory; it is only the working directory for
model-catalog probing（cache key: `cwd` + config root / base URL）and does not select a
namespace:

```json
{
  "cwd": "/absolute/path/to/project"
}
```

Every adapter entry contains:

- `models`: normalized model entries. `id` is the value accepted by `metadata.model` or the
  adapter-specific model field. Optional metadata includes `resolved_id`, `description`,
  `supported_efforts`, `default_effort`, `context_window`, `input_modalities`, and
  `capabilities`.
- `model_discovery.status`: `available` when the CLI returned a valid catalog, otherwise
  `unavailable`.
- `model_discovery.source`: the CLI discovery surface used for that adapter.
- `model_discovery.reason`: present only when discovery failed.

Model discovery failure does not make the adapter unavailable. In that case `models` is an
empty array, while normal dispatch remains usable. Results are cached for 30 seconds per
`cwd` + config root / base URL.

Namespaces are not resolved or enforced by Agent Hub: the caller's session-axis state is
forwarded whole with `NS_REBIND=1`, the agent CLI is started through `zsh` at the run
`cwd`, and charter's glue rebinds the domain by `cwd` at birth. Container roots
(Claude/Codex/Kimi/OpenCode) are machine-level singletons.

### run_agent

Dispatches a run and waits until it reaches a terminal state or the timeout expires. This is a convenience wrapper for short work; long-running tasks should use `dispatch_to_agent` plus polling.

```json
{
  "agent_id": "claude-code",
  "prompt": "Review the current diff.",
  "cwd": "/absolute/path/to/project",
  "cli_session_ref": null,
  "metadata": {
    "claude": {
      "model": "sonnet",
      "effort": "medium"
    }
  },
  "timeout_ms": 30000,
  "poll_interval_ms": 1000
}
```

Important request rules:

- `agent_id` must be `claude-code`, `codex`, `kimi-code`, or `opencode`.
- `prompt` is passed to the agent CLI without wrapper text (via stdin, or as the `-p` argv value for kimi).
- `cwd` must be an existing absolute directory.
- `timeout_ms` defaults to `30000` and is capped at `3600000`.
- `poll_interval_ms` defaults to `1000`.

If the wait times out while the run is still active, the response has `status: "running"` and `timed_out: true`; keep the `run_ref` and call `query_agent_run` or `wait_agent_run` again. Do not treat this as failure and do not cancel solely because a wait timed out.

### dispatch_to_agent

Starts a run and returns immediately:

```json
{
  "status": "accepted",
  "run_ref": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "cli_session_ref": {
    "agent_id": "claude-code",
    "native_session_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "poll_after_ms": 1000
}
```

### query_agent_run

Reads the latest snapshot:

```json
{
  "run_ref": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

Running snapshots include a `content` reminder to keep polling and can include `progress_events` and `log_tail`. Terminal snapshots include final `content`, `artifacts`, and possibly `error`.

### wait_agent_run

Blocks on an existing run:

```json
{
  "run_ref": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

MCP callers do not provide wait duration or poll interval. Agent Hub waits up to 10 minutes and polls once per second. A timed-out wait returns a running snapshot and leaves the run active. If the MCP host times out first, the run is still active; call `query_agent_run` or `wait_agent_run` again with the same `run_ref`.

### cancel_agent_run

Requests cancellation of the run process group:

```json
{
  "run_ref": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "reason": "user requested stop",
  "actor": "mcp-client"
}
```

## Discussions

The CLI starts a detached coordinator for each Discussion, so no HTTP daemon is required:

```sh
agenthub discussion dispatch --json-file /absolute/path/discussion.json
agenthub discussion wait DISCUSSION_ID
agenthub discussion list --status completed,failed --since 7d --cwd "$PWD"
```

`discussion query`, `wait`, and `cancel` recover a nonterminal record on demand. A lease prevents concurrent coordinators from advancing the same record.
`discussion list` is CLI-only and never resumes a record; it scans the retained state projections
and reports corrupt or missing state files through `source_errors` instead of hiding them.

For MCP compatibility, Discussion tools are also available from the optional HTTP daemon:

```sh
node src/server.js --transport streamable-http --host 127.0.0.1 --port 8700 --path /mcp
```

`dispatch_discussion` accepts either a new discussion or a follow-up. A new discussion fixes the host, participant roster, role/focus, quorum, working directory, and material bundle before any CLI run starts:

```json
{
  "kind": "new",
  "objective": "Select an implementation",
  "question": "Which option should ship?",
  "cwd": "/absolute/path/to/project",
  "materials": [
    {
      "material_id": "design",
      "type": "file",
      "title": "Current design",
      "path": "docs/design.md"
    }
  ],
  "host": {
    "agent_id": "claude-code",
    "metadata": {"claude": {"model": "sonnet"}}
  },
  "participants": [
    {
      "participant_id": "reliability",
      "agent_id": "codex",
      "role": "reliability reviewer",
      "focus": "recovery, leases, and idempotency",
      "metadata": {}
    },
    {
      "participant_id": "product",
      "agent_id": "kimi-code",
      "role": "product reviewer",
      "focus": "scope and usability",
      "metadata": {}
    }
  ],
  "quorum": 2,
  "budget_profile": "standard"
}
```

The response is immediate:

```json
{
  "status": "accepted",
  "discussion_ref": {"discussion_id": "..."},
  "poll_after_ms": 1000
}
```

Call `query_discussion` for a snapshot or `wait_discussion` for the server's ten-minute wait window. Both accept `after_sequence` and `limit` (maximum 200) for event pagination. A wait response with `timed_out: true` is not a failure and does not cancel the discussion. `cancel_discussion` persists cancellation intent and cancels every known active run before the discussion becomes terminal.

CLI and HTTP query/wait snapshots include additive diagnostics:

- `completion_quality`: `complete` for a completed intact protocol, `partial` for
  `completed + degraded`, `failed` for failed/unknown terminal records, and `null` while no quality
  can be assigned.
- `phase_statistics`: required/accepted/failed/pending turn counts, attempt outcomes, recognized
  deadline counts, and event-derived phase timing.
- `failure_summary`: the terminal error, concrete last failed attempt, and bounded failed
  turn/attempt details. Unknown provenance and phase-deadline causes remain distinct.
- `budget_status`: frozen profile, source, total/elapsed/remaining budget, current phase remaining
  time, future-phase reserve, and the minimum repair window.

The daemon executes a fixed five-phase protocol: independent memos, host moderation, participant challenge, participant revision, and host synthesis. The process is not interactive; callers add information only by starting a follow-up after completion. A follow-up inherits the original objective, cwd, host, participants, roles, focus, quorum, request metadata, and budget profile:

```json
{
  "kind": "follow_up",
  "parent_discussion_ref": {"discussion_id": "..."},
  "question": "Does the decision change under the new constraint?",
  "materials": [
    {
      "material_id": "constraint",
      "type": "inline",
      "title": "New constraint",
      "content": "The migration must finish in one week."
    }
  ]
}
```

The parent must still be retained and must have completed with a valid DecisionRecord. Follow-ups atomically claim resumable member session lineages where possible; otherwise they rebuild context from the frozen handoff. Sibling follow-ups cannot fork the same CLI session history.

`quick`, `standard`, and `research` have hard caps of 30, 60, and 90 minutes. `standard` is the
default. Each accepted Discussion freezes the resolved budget in state: phase maximums can use
time saved by earlier phases, while absolute cutoffs keep minimum time reserved for every later
phase. A second attempt that only repairs structured output is skipped with
`repair_budget_exhausted` when it cannot receive the profile's full minimum repair window. Runtime
failure retries remain governed by their existing retryability rules.

Discussion permissions are capability-driven and cannot be overridden in host/participant metadata. Current capabilities prefer `read-only` for Claude and Codex, and `auto` for Kimi because Kimi prompt mode has no read-only permission. This is best-effort behavior, not a sandbox guarantee. Each material is limited to 128 KiB, the bundle to 256 KiB, and terminal discussions plus linked runs are retained for seven days by default.

Completed snapshots include deterministic Markdown in `content`, the authoritative structured `decision`, effective permission/network disclosure, artifacts, event cursor, and all associated `run_refs`. See [discussion-design.md](discussion-design.md) for message schemas and recovery invariants.

## Unified Metadata

Top-level `metadata` fields translate through each adapter where the target CLI has an equivalent. The adapter namespaces below (`metadata.claude`, `metadata.codex`, `metadata["kimi-code"]`, `metadata.opencode`) remain available as native escape hatches and take precedence over unified fields.

| Field | Meaning | claude-code | codex | kimi-code | opencode |
|---|---|---|---|---|---|
| `model` | Model name in the target CLI's naming | `--model` | `--model` | `-m` | `--model` |
| `permission` | `read-only`, `auto` (default), or `full` | `plan` / `auto` / `bypassPermissions` | `read-only` / `workspace-write` + network / `danger-full-access` | Only `auto` is accepted: kimi `-p` always runs with built-in auto approval. | Only `auto` is accepted and maps to `--auto`; explicit OpenCode deny rules remain enforced. |
| `add_dirs` | Extra writable directories (resolved and allowlist-checked) | `--add-dir` | `--add-dir` | `--add-dir` | Non-empty values rejected; OpenCode has no add-dir boundary. |

Effort is deliberately not unified: each CLI has its own evolving value vocabulary, so Agent Hub does not enumerate valid values — it passes the string through and lets the target CLI accept or reject it (rejections surface through the normal failure path). Set it per request in the adapter namespace (`metadata.claude.effort` / `metadata.codex.effort` / `metadata["kimi-code"].effort` / `metadata.opencode.effort`) or configure the corresponding `AGENT_HUB_*_EFFORT` environment default. OpenCode maps effort to `--variant`; the provider validates the value.

With the default `permission: "auto"`, all adapters can edit the workspace, run commands, and reach the network. `full` bypasses the CLI's guardrails — only use it in externally sandboxed environments.

Model-side failures are reported with the unified error code `agent_error` regardless of adapter (Claude `is_error`, Codex `turn.failed`, kimi `failed to run prompt` on stderr, OpenCode JSON `error` event); the native detail stays in `error.message` and `result.txt`. `cli_exit_nonzero` and `stdout_parse_failed` remain adapter-independent.

## Claude Metadata

`metadata.claude` maps to Claude Code CLI flags:

| Field | CLI flag | Notes |
|---|---|---|
| `model` | `--model` | Optional non-empty string. |
| `effort` | `--effort` | Optional non-empty string; falls back to `AGENT_HUB_CLAUDE_EFFORT`. |
| `agent` | `--agent` | Optional non-empty string. |
| `output_format` | `--output-format` | Defaults to `stream-json`; set to `json` for legacy single-result output. |
| `permission_mode` | `--permission-mode` | Defaults to `auto`. |
| `add_dirs` | `--add-dir` | Array of directories resolved and allowlist-checked before execution. |

Supported `permission_mode` values are `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, and `plan`. Normal integrations should omit the field and let Agent Hub pass `auto`.

## Codex Metadata

`metadata.codex` maps to Codex CLI flags:

| Field | CLI flag | Notes |
|---|---|---|
| `model` | `--model` | Optional non-empty string. |
| `effort` | `-c model_reasoning_effort="…"` | Optional; letters, digits, hyphens, underscores only; falls back to `AGENT_HUB_CODEX_EFFORT`. |
| `sandbox` | `--sandbox` | Native escape hatch; overrides unified `permission` and keeps codex-native semantics (`workspace-write` without network). One of `read-only`, `workspace-write`, `danger-full-access`. |
| `add_dirs` | `--add-dir` | Array of directories resolved and allowlist-checked before execution. |

On continuations (`codex exec resume`) the sandbox and writable roots are passed as `-c sandbox_mode="…"` and `-c sandbox_workspace_write.writable_roots=[…]` config overrides because the resume subcommand accepts a narrower flag set.

## Kimi Metadata

`metadata["kimi-code"]` maps to Kimi Code CLI flags:

| Field | CLI flag | Notes |
|---|---|---|
| `model` | `-m` | Optional non-empty string. |
| `effort` | `KIMI_MODEL_THINKING_EFFORT` env | Optional; passed through unvalidated (documented values: `low`/`medium`/`high`/`xhigh`/`max`); falls back to `AGENT_HUB_KIMI_EFFORT`. |
| `add_dirs` | `--add-dir` | Array of directories resolved and allowlist-checked before execution. |

Kimi prompt mode takes no permission flags (`--plan`/`--auto`/`--yolo` conflict with `-p`), and its built-in auto approval matches the unified default `permission: "auto"`. Unified `read-only` or `full` fail command construction in the runner (the run is accepted, then ends `failed` with `runner_exception`) — the same stage where other adapters validate their native metadata.

## OpenCode Metadata

`metadata.opencode` maps to OpenCode `run` flags:

| Field | CLI flag | Notes |
|---|---|---|
| `model` | `--model` | Optional `provider/model`; falls back to `AGENT_HUB_OPENCODE_MODEL`. |
| `effort` | `--variant` | Optional provider-native reasoning variant; falls back to `AGENT_HUB_OPENCODE_EFFORT`. |
| `agent` | `--agent` | Optional OpenCode agent name. |

OpenCode runs as `opencode run --format json --auto` and reads the exact prompt from stdin. Only unified `permission: "auto"` is supported: OpenCode treats `--auto` like its yolo flag for asked permissions, has no workspace filesystem boundary, and retains only explicit deny rules. `full` has no distinct stable mapping and `read-only` cannot be guaranteed across user-defined agents. Non-empty `add_dirs` is rejected because OpenCode exposes no additional-directory boundary. Unsupported `permission` or `add_dirs` values are accepted as runs and then fail during command construction with `runner_exception`, matching the validation stage used by other adapters.

OpenCode JSONL is retained in `events.jsonl`. Provider-native transcript inspection is available
through `agent-session`; live run `progress_events` projection remains outside this adapter's
initial scope, so running snapshots still rely on stderr/log artifacts until terminal results.

## Session Continuation

For a new session, pass `cli_session_ref: null`.

- `claude-code`: Agent Hub creates a UUID and passes it as `--session-id`; the dispatch response already contains the `cli_session_ref`.
- `codex`: Codex assigns the thread id itself, so the dispatch response has `cli_session_ref: null`. The id appears on running/terminal snapshots once Codex reports it (usually within the first second).
- `kimi-code`: Kimi assigns the session id itself and reports it in the final `session.resume_hint` event, so the dispatch response has `cli_session_ref: null` and the id appears on the terminal snapshot. A cancelled kimi run has no resumable session ref.
- `opencode`: OpenCode assigns a `ses_*` id and includes it on every JSON event. The dispatch response has `cli_session_ref: null`; the runner records the ref from the first event, so a cancelled run can retain it.

To continue, pass back the previous terminal response's `cli_session_ref`:

```json
{
  "agent_id": "claude-code",
  "native_session_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Agent Hub then calls Claude Code with `--resume <native_session_id>`, Codex with `codex exec resume <native_session_id>`, Kimi with `kimi --session <native_session_id> -p …`, or OpenCode with `opencode run --session <native_session_id> …`. The `agent_id` inside `cli_session_ref` must match the request's `agent_id`; every argv session id is shape-validated before command construction.

## Artifacts

Responses can include artifacts stored inside the run directory:

- `request.json`
- `command.json`
- `stdout.log`
- `stderr.log`
- `events.jsonl`
- `runner.log`
- `result.json`
- `result.txt`

`content[0].text` is read from `result.txt` for terminal runs.

# Agent Instructions

## Review Routing

- A code-review request addressed to the current process is direct work; do not invoke `agenthub review dispatch` merely because the task mentions a PR, diff, change, or review. Use `agenthub review dispatch` automatically only after this process creates or updates a PR under the machine policy, or when the user explicitly requests Agent Hub's routed cross-review. If the user names another reviewer, ordinary dispatch is the transport and the selected reviewer reviews directly.

## Project Shape

This repository implements a daemon-free Agent Hub CLI and versioned Skill sources, plus optional MCP compatibility transports. It maps requests to non-interactive agent CLI runs (Claude Code, Codex, Kimi Code, and OpenCode), stores local artifacts, and coordinates durable structured discussions.

Key files:

| Path | Purpose |
|---|---|
| `src/cli.js` | Primary `agenthub` command surface. |
| `src/server.js` | Optional MCP stdio/HTTP compatibility server. |
| `src/runs.js` | Tool behavior, run lifecycle, waiting, cancellation, snapshots. |
| `src/runner.js` | Detached runner that launches the agent CLI and writes terminal results. |
| `src/birth-command.js` | Shared cwd-bound zsh birth launcher and private post-birth environment handoff. |
| `src/adapters.js` | Adapter registry keyed by `agent_id`. |
| `src/claude-adapter.js` | Claude Code argv/session/result mapping. |
| `src/claude-auth.js` | Secure runner-only Claude setup-token file loading and launch overlay. |
| `src/codex-adapter.js` | Codex CLI argv/session/result mapping. |
| `src/kimi-adapter.js` | Kimi Code argv/session/result mapping. |
| `src/opencode-adapter.js` | OpenCode argv/session/result/model-catalog mapping. |
| `src/review-routing.js` | Requester-specific review configuration, status validation, and dispatch. |
| `src/adapter-utils.js` | Shared adapter helpers (metadata assertions, version probe). |
| `src/agent-session-core.js` | Provider-neutral session identity, provenance, and pure live-event projections. |
| `src/agent-session-references.js` | Versioned stable native-event URI formatting, identity, and parsing. |
| `src/agent-session-transcripts.js` | Pure Claude/Codex/Kimi/OpenCode native transcript projections. |
| `src/agent-session-resources.js` | Pure high-confidence file/Skill access extraction for session tool steps. |
| `src/agent-session-sources.js` | Side-effect-free native session discovery and cursor reads. |
| `src/session-cli.js` | Read-only `agent-session list/inspect/serve` command surface. |
| `src/session-server.js` | Loopback-only no-store session API for Cockpit. |
| `src/fs-store.js` | Run storage, atomic writes, TTL cleanup, state locks. |
| `src/session-registry.js` | Cross-run session leases, generations, and lineage claims. |
| `src/eval-run.js` | Interactive repository-eval supervisor, per-case execution, grading, and telemetry. |
| `src/eval-runtime.js` | Content-addressed Eval runtime capsule provisioning, validation, and read-only command overlays. |
| `src/eval-toolchain.js` | Generic evaluator-provisioned toolchain capsule validation, sealing checks, and content identity. |
| `src/eval-protocol.js` | Question-suite, source-location answer, Git snapshot, digest, and grader contracts. |
| `src/eval-store.js` | Private TTL-bound eval-result storage; never stores plaintext standard answers. |
| `src/discussion-manager.js` | Durable five-phase Discussion coordinator and recovery controller. |
| `src/discussion-cli.js` | CLI Discussion dispatch, passive query/wait/cancel, and worker startup. |
| `src/discussion-worker.js` | Detached per-Discussion coordinator process. |
| `src/discussion-protocol.js` | Discussion input/output schemas, limits, and provenance validation. |
| `src/discussion-store.js` | Discussion events, projections, leases, artifacts, and TTL cleanup. |
| `src/discussion-observability.js` | Derived list summaries, completion quality, phase statistics, and bounded failure diagnostics. |
| `src/discussion-budget.js` | Frozen budget profiles, future-phase reserves, phase deadlines, and repair-window diagnostics. |
| `src/discussion-materials.js` | Frozen material bundles, file validation, hashing, and handoff data. |
| `src/discussion-prompts.js` | Versioned turn and format-repair prompts. |
| `src/discussion-render.js` | Deterministic DecisionRecord Markdown rendering. |
| `src/review-prompts.js` | Versioned reviewer-control prompt construction. |
| `src/review-context.js` | Routed review provenance, depth marker, and nested-dispatch guard. |
| `src/security.js` | `cwd` and `add_dirs` validation. |
| `src/env.js` | Environment allowlist and forwarding. |
| `scripts/mcp-client.js` | Local MCP smoke-test client. |
| `skills/agent-hub/` | Versioned Codex Skill for CLI collaboration workflows. |
| `skills/eval-driven-refactor/` | Versioned Codex Skill for controlled before/after refactor evaluation. |

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

- Preserve prompt pass-through for ordinary run tools: do not prepend wrapper prompts, system prompts, or result-file instructions to user input. Review dispatch uses the versioned reviewer-control prompt in `src/review-prompts.js`; Discussion turns use only the versioned coordinator templates in `src/discussion-prompts.js`.
- Eval may combine an evaluator-supplied question snapshot with the fixed `source-location/v1` output contract or `workspace-patch/v1` completion contract, but it must never include the human standard, expose an external suite path to the child, silently weaken an execution profile, or grant a patch profile to the caller's original worktree instead of a disposable detached worktree. A schema-v2 suite may opt into `verifier_preflight: "subject-reject-known-good-pass/v1"`; this must collect a clean committed same-repository descendant known-good worktree per case, require the same pinned verifier to reject the untouched disposable subject and accept the known-good disposable, and finish every case preflight before the first agent dispatch. Its verifier remains a trusted foreground process. A preflight failure creates neither an ordinary run nor an Eval artifact. Oracle lexical and real paths must not overlap the subject or any runtime/toolchain capability readable by the child; overlap is a fatal command error because reprompting cannot revoke that readability. Control paths, commits, contents, and verifier output never enter child inputs or results. Schema-v2 suites, `python-runtime-capsule/v1`, result schemas v1-v4, and graders through `workspace-patch/v2` keep their existing semantics.
- A schema-v3 patch suite must use `verifier_preflight: "subject-reject-known-good-pass/v2"`, declare `toolchain_requirements: {kind: "command-smoke/v1", commands: [...]}`, select an evaluator-provisioned absolute `eval-toolchain-capsule/v1` manifest with `--toolchain`, run every declared argv smoke through the final `workspace-write/v2` Codex sandbox before collecting standards or starting a model run, and run both verifier controls and final grading through that same versioned capability plan. Generic capsules are content-digested, platform-bound, contained, hardlink-safe, permission-bit-sealed, and forbidden from overlapping either the worktree or its Git common directory; Agent Hub does not install them or discover, download, copy, or fall back to host tools. Result schema v5 / grader `workspace-patch/v3` records only public capsule identity, command names, capability/preflight digests, and execution facts, omitting subject/storage absolute paths. This proves parity for the declared, successfully smoked commands; it does not statically prove the dependency closure of arbitrary dynamically selected behavior, so evaluators must declare representative smokes and independently review the verifier. Eval requires an explicit model and effort; it never selects either from defaults.
- Keep `run_id` and `cli_session_ref.native_session_id` separate. A continuation creates a new run and resumes the CLI session.
- Codex assigns its own thread id: a new `codex` run dispatches with `cli_session_ref: null` and the runner backfills it from the first `thread.started` event.
- Kimi assigns its own session id and reports it only in the final `session.resume_hint` event: a new `kimi-code` run dispatches with `cli_session_ref: null` and the ref appears on the terminal snapshot.
- OpenCode assigns its own `ses_*` session id and reports it on every JSON event: a new `opencode` run dispatches with `cli_session_ref: null`, and the runner backfills the ref from the first event.
- `cwd` must remain an explicit absolute directory from the request; `metadata.claude.add_dirs`, `metadata.codex.add_dirs`, and `metadata["kimi-code"].add_dirs` must resolve through `src/security.js`. OpenCode has no add-dir boundary and rejects non-empty `metadata.opencode.add_dirs`.
- Unified metadata (`metadata.model` / `permission` / `add_dirs`) maps to native flags where the CLI has an equivalent; the adapter namespaces (`metadata.claude.*`, `metadata.codex.*`, `metadata["kimi-code"].*`, `metadata.opencode.*`) take precedence. Effort is adapter-native only (`metadata.<adapter>.effort`, falling back to `AGENT_HUB_CLAUDE_EFFORT` / `AGENT_HUB_CODEX_EFFORT` / `AGENT_HUB_KIMI_EFFORT` / `AGENT_HUB_OPENCODE_EFFORT`) because each CLI has its own value vocabulary. Model-side failures use the unified error code `agent_error`.
- The default unified permission is `auto`: `--permission-mode auto` for Claude, `--sandbox workspace-write` plus `network_access=true` for Codex, kimi `-p`'s built-in auto approval for Kimi Code, and `--auto` for OpenCode. OpenCode `--auto` is yolo-equivalent for asked permissions, has no workspace filesystem boundary, and retains only explicit deny rules. Kimi/OpenCode reject unified `read-only`/`full` rather than remapping them. Do not use `permission: "full"`, `bypassPermissions`, `danger-full-access`, or `--dangerously-bypass-approvals-and-sandbox` in examples, defaults, or self-review paths unless the user explicitly asks.
- Keep process cancellation scoped to the recorded process group for the run.
- Keep run directories and state/log artifacts private (`0700` directories, `0600` files where applicable).
- Do not record environment variable values in command metadata.

## Environment Variables

| Variable | Meaning |
|---|---|
| `AGENT_HUB_RUN_DIR` | Override run storage root. |
| `AGENT_HUB_RUN_TTL_SECONDS` | Terminal run retention; default is `604800`. |
| `AGENT_HUB_EVAL_DIR` | Private eval-result storage root. |
| `AGENT_HUB_EVAL_TTL_SECONDS` | Eval-result retention; default follows run TTL. |
| `AGENT_HUB_EVAL_RUNTIME_DIR` | Private content-addressed Eval runtime capsule store. |
| `AGENT_HUB_DISCUSSION_DIR` | Override Discussion storage root. |
| `AGENT_HUB_DISCUSSION_TTL_SECONDS` | Terminal Discussion retention; default follows run TTL. |
| `AGENT_HUB_HTTP_ALLOWED_ORIGINS` | Exact comma-separated browser origins allowed to call the loopback HTTP daemon. |
| `AGENT_HUB_CWD_ALLOWLIST` | Optional path-delimited allowlist for `cwd` and `add_dirs`. |
| `AGENT_HUB_FORWARD_ENV` | Comma-separated extra env keys forwarded to the agent CLI. |
| `AGENT_HUB_REVIEW_CONFIG` | Override the requester-specific review-routing JSON path. |
| `AGENT_HUB_CATALOG_CACHE_DIR` | Override the private cross-process catalog cache used by `review status`. |
| `AGENT_HUB_CLAUDE_MODEL` | Default model for Claude runs. |
| `AGENT_HUB_CLAUDE_OAUTH_TOKEN_FILE` | Absolute 0600 setup-token file read only for Claude model discovery and runs. |
| `AGENT_HUB_CODEX_MODEL` | Default model for Codex runs. |
| `AGENT_HUB_CLAUDE_EFFORT` | Default effort for Claude runs. |
| `AGENT_HUB_CODEX_EFFORT` | Default effort for Codex runs. |
| `AGENT_HUB_KIMI_MODEL` | Default model for Kimi runs. |
| `AGENT_HUB_KIMI_EFFORT` | Default effort for Kimi runs. |
| `AGENT_HUB_OPENCODE_MODEL` | Default model for OpenCode runs. |
| `AGENT_HUB_OPENCODE_EFFORT` | Default variant/effort for OpenCode runs. |

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
| `README.md` | Installing, smoke testing, or wiring the CLI/Skills and optional MCP server. |
| `docs/integration-guide.md` | Implementing a client call flow or understanding request/response shapes. |
| `docs/operator-runbook.md` | Operating, configuring, or troubleshooting local runs. |
| `docs/architecture.md` | Changing lifecycle, storage, adapter, or process-group behavior. |
| `docs/agent-session-core.md` | Changing provider-neutral session/event projections or content profiles. |
| `docs/discussion-design.md` | Changing the fixed Discussion protocol, schemas, recovery, or safety boundaries. |
| `docs/evals.md` | Changing repository question suites, human answer handling, eval isolation, grading, or result facts. |

# Repository evaluations

Agent Hub evaluations answer one narrow question: can a fresh coding-agent session return the
repository location that a human evaluator supplied for the current commit? Agent Hub runs and
grades one suite; it does not compare commits, rank runs, or maintain a long-term benchmark. A
consumer such as Cockpit may ingest the resulting facts and choose its own comparison cohorts.

## Repository-owned questions

The default suite path is `.agenthub/evals.json` in the evaluated Git worktree:

```json
{
  "schema_version": 1,
  "suite_id": "code-navigation",
  "cases": [
    {
      "id": "locate-resource-filter",
      "prompt": "Find the production definition that applies the resource worktree filter.",
      "answer_schema": "source-location/v1"
    }
  ]
}
```

Suites contain questions only. Oracle fields, expected paths, immutable source comments, and
grader scripts are rejected. The suite and evaluated worktree must be clean and committed before
the run starts. `--suite` may select another JSON file, but that file must still resolve inside the
evaluated worktree. The machine-readable suite contract is
[`schemas/agent-eval-suite-v1.schema.json`](../schemas/agent-eval-suite-v1.schema.json).

V1 accepts only `source-location/v1`. A standard answer and agent output both contain exactly:

```json
{
  "path": "src/resource-hotspots.js",
  "symbol": "queryResourceHotspots",
  "definition_line": 84
}
```

`path` is repository-relative, `symbol` is a non-empty string, and `definition_line` is a positive
1-based line. Agent Hub validates that a human answer names an existing in-worktree regular file
and a line inside it, then performs exact comparison after normalizing the relative path. V1 does
not infer symbols with an AST or use model grading.

## One-command flow

Run from the repository root:

```sh
agenthub eval run --agent codex --cwd "$PWD"
```

Optional flags select the suite, model, effort, or per-case timeout:

```sh
agenthub eval run \
  --agent codex \
  --cwd "$PWD" \
  --suite .agenthub/evals.json \
  --model gpt-5.6-sol \
  --effort medium \
  --timeout-ms 600000
```

The command writes questions and field prompts to stderr, reads all human answers from the
interactive terminal, and prints one final JSON result to stdout. It collects every answer before
starting the first agent case. There is no prepare command and no answer file.

The standard answers remain in the foreground Eval supervisor's memory. They are never included in
the agent prompt, argv, child environment, ordinary run request, or eval result. Only a canonical
`answer_digest` is retained. If the supervisor exits before completion, rerun the evaluation; V1
does not recover an in-memory oracle after interruption.

## Isolation contract

The `workspace-readonly/v1` profile is fail-closed:

- Each case starts a new non-resumed, ephemeral Codex session.
- Codex user configuration and exec rules are ignored for the case.
- Codex memories, external memory import, and subagents are disabled.
- Codex permission profiles expose only `:minimal` runtime paths, the resolved Codex executable
  directories (including its standalone runtime root), and the current workspace as read-only data.
- `.git` is denied inside the workspace, so linked worktree pointers and repository history are not
  agent-readable.
- A new private scratch directory is the only writable path and is removed after the case.
- Command network access is disabled. Provider model traffic remains the trusted Codex control
  channel and is not command network access.
- The structured output schema is public and lives in the private scratch directory; it contains no
  oracle data.

The profile currently requires `codex-cli` 0.151.0 or newer. Other Agent Hub providers return
`unsupported_isolation` until their adapters can enforce the same filesystem, memory, network, and
session-persistence contract. Agent Hub never silently falls back to an adapter's broader normal
permission mode.

## Result and retention

Every completed eval command stores one private `0600` JSON result under
`${AGENT_HUB_EVAL_DIR}` or, by default,
`${XDG_STATE_HOME:-~/.local/state}/agent-hub-mcp/evals/`. The result contains:

- suite, question, answer, workspace, and grader digests;
- the exact commit, agent version, model, effort, and isolation policy;
- per-case pass/fail/invalid/error status and the backing ordinary `agent_run_ref`;
- elapsed time, usage, turn/tool counts, and high-confidence observed file-read counts.

It does not contain question text, standard answers, or parsed agent answers. The backing ordinary
run keeps the provider-native prompt/output artifacts under the existing run TTL, outside the
agent-readable workspace.

The machine-readable contract is
[`schemas/agent-eval-result-v1.schema.json`](../schemas/agent-eval-result-v1.schema.json).

Eval results default to the ordinary seven-day run TTL. Override storage or retention with:

```text
AGENT_HUB_EVAL_DIR
AGENT_HUB_EVAL_TTL_SECONDS
```

Expired result files are removed on the next eval run. Comparison and long-term retention remain
outside Agent Hub.

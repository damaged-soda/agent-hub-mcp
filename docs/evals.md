# Repository evaluations

Agent Hub evaluations run one repository-owned question suite against one immutable commit. A
suite either asks fresh coding-agent sessions to locate production code or to implement a change
inside disposable worktrees. Agent Hub runs and grades one suite; it does not compare commits,
rank runs, or maintain a long-term benchmark. A consumer such as Cockpit may ingest the resulting
facts and choose its own comparison cohorts.

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
evaluated worktree. The machine-readable suite contracts are
[`schemas/agent-eval-suite-v1.schema.json`](../schemas/agent-eval-suite-v1.schema.json) and
[`schemas/agent-eval-suite-v2.schema.json`](../schemas/agent-eval-suite-v2.schema.json).

Suite schema v1 accepts only `source-location/v1`. A standard answer and agent output both contain
exactly:

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

Suite schema v2 accepts only `workspace-patch/v1`:

```json
{
  "schema_version": 2,
  "suite_id": "resource-parser-changes",
  "cases": [
    {
      "id": "recognize-another-reader",
      "prompt": "Recognize the requested literal-file reader without treating dynamic paths as reads.",
      "answer_schema": "workspace-patch/v1"
    }
  ]
}
```

For each patch case, the evaluator supplies one absolute executable verifier path interactively.
The verifier must be a self-contained regular executable outside both the evaluated workspace and
the agent's runtime read capabilities. Agent Hub pins its content digest in memory and starts the
case from the subject commit in a fresh detached worktree. Only after the agent exits, the
supervisor copies the still-matching verifier bytes to a new private directory that was never part
of the agent permission profile under the private Eval state root and executes that copy with the
disposable worktree as cwd. Exit zero passes; a nonzero exit fails. Verifier stdout/stderr are
drained without retention or a grading size limit. The verifier path, contents, output, and agent patch body are not
persisted in the eval result. Only the verifier digest, bounded change metrics, and patch digest are
retained. The verifier may inject hidden tests before invoking the repository's ordinary test
entrypoint.

Schema v1 and v2 cases cannot be mixed in one suite. Use separate suite files and `--suite` when
both kinds are needed.

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

The command writes questions and standard prompts to stderr, reads all human standards from the
interactive terminal, and prints one final JSON result to stdout. It collects every standard before
starting the first agent case. Location suites ask for `path`, `symbol`, and `definition_line`;
patch suites ask for an executable verifier path. There is no prepare command and no answer file.

The standards remain in the foreground Eval supervisor's memory. They are never included in
the agent prompt, argv, child environment, ordinary run request, or eval result. Only a canonical
`answer_digest` is retained. If the supervisor exits before completion, rerun the evaluation; Eval
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

Patch suites use the companion `workspace-write/v1` profile. It keeps every restriction above but
changes the current workspace capability from read to write. The writable workspace is a new
detached worktree at the evaluated commit, never the worktree passed through `--cwd`. `.git`
remains denied, command network remains disabled, and temp files are redirected into the private
per-case scratch directory. To let repository tests use the same system Python as the foreground
evaluator, Agent Hub detects `python3` before collecting standards and grants its executable,
prefix, and enclosing macOS Command Line Tools root read-only; no Python user site, package cache,
or home directory is added. Disposable worktree creation overrides `core.hooksPath` with a private
empty directory, so repository checkout hooks cannot publish the temporary path or mutate external
state. Agent Hub records the patch before verifier execution and removes the worktree afterward.
Patch metric collection is best-effort telemetry: an oversized or otherwise unprojectable patch is
reported as `patch.status = "unavailable"` but does not skip or override verifier grading. Worktree
cleanup always attempts both Git deregistration and filesystem removal; a cleanup failure is
reported to the foreground stderr without replacing the completed case result.

The agent sandbox does not extend to verifier execution. The verifier is evaluator-trusted and may
execute code written by the agent with the foreground user's filesystem and network authority when
it invokes repository tests. A background process deliberately left by the agent is another known
residual risk: Agent Hub does not kill a persisted process group from stored pid metadata because of
pid-reuse/incorrect-target risk. The verifier copy stays outside the agent permission profile, but
patch eval is not a hostile-code sandbox. Run it only on repositories and tasks for which executing
the resulting tests as the current user is acceptable.

## Result and retention

Every completed eval command stores one private `0600` JSON result under
`${AGENT_HUB_EVAL_DIR}` or, by default,
`${XDG_STATE_HOME:-~/.local/state}/agent-hub-mcp/evals/`. The result contains:

- suite, question, answer, workspace, and grader digests;
- the exact commit, agent version, model, effort, and isolation policy;
- per-case pass/fail/invalid/error status and the backing ordinary `agent_run_ref`;
- elapsed time, usage, turn/tool counts, and high-confidence observed file-read counts;
- for patch suites, observed write counts, bounded change statistics, patch digest, and verifier
  exit status.

The eval result does not contain question text, standard answers/verifiers, parsed agent answers,
patch bodies, or verifier output. The backing ordinary run keeps the ordinary provider-native
prompt and tool transcript under the existing run TTL, so commands and code excerpts observed by
the agent may still be present there; verifier identity, contents, and output never enter that run.

The machine-readable contracts are
[`schemas/agent-eval-result-v1.schema.json`](../schemas/agent-eval-result-v1.schema.json) and
[`schemas/agent-eval-result-v2.schema.json`](../schemas/agent-eval-result-v2.schema.json).

Eval results default to the ordinary seven-day run TTL. Override storage or retention with:

```text
AGENT_HUB_EVAL_DIR
AGENT_HUB_EVAL_TTL_SECONDS
```

Expired result files are removed on the next eval run. Comparison and long-term retention remain
outside Agent Hub.

# Repository evaluations

Agent Hub evaluations run one evaluator-selected question suite against one immutable commit. A
suite either asks fresh coding-agent sessions to locate production code or to implement a change
inside disposable worktrees. The suite is evaluator input, not part of the subject: Agent Hub
snapshots and hashes it at command startup, while the evaluated worktree must remain clean and
committed. Agent Hub runs and grades one suite; it does not compare commits, rank runs, or maintain
a long-term benchmark. A consumer such as Cockpit may ingest the resulting facts and choose its own
comparison cohorts.

An optional verifier preflight may execute the evaluator-trusted grader against disposable control
worktrees before dispatch. Those controls are input validation, not additional Eval subjects: no
model runs against them, no work metrics or ranking are produced for them, and one completed Eval
result still describes exactly one subject commit.

The versioned `eval-driven-refactor` Skill provides an opinionated workflow for designing controlled
before/after cases and interpreting paired results without changing this single-run boundary. The
target repository may provide sample questions, while evaluator-selected suites, comparisons, and
conclusions remain evaluator-owned.

## Evaluator-owned questions

Repositories may version `.agenthub/evals.json` as the default sample suite:

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

Suites contain questions plus an optional public verifier-preflight policy, never oracle material.
Expected paths, control identities, immutable source comments, and grader scripts are rejected.
The evaluated worktree must be clean and committed, but the selected suite
does not need to be. `--suite` may select an absolute file anywhere readable by the foreground
evaluator; a relative path resolves from the evaluated worktree root. External suite paths are not
added to the child agent's readable capabilities. The normalized suite is held in supervisor memory,
so edits after command startup do not change the accepted questions or digests. The machine-readable
suite contracts are
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
  "verifier_preflight": "subject-reject-known-good-pass/v1",
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

`verifier_preflight` is optional and accepts only
`subject-reject-known-good-pass/v1`. When enabled, the interactive standard for each case also
includes a different clean, committed worktree from the same Git repository whose different
descendant commit is known to satisfy that case. The supervisor pins the suite, verifier, runtime,
subject, and known-good worktree before executing the verifier on fresh disposable copies. It first
requires a nonzero exit against the
untouched subject and then a zero exit against the known-good control. Every case must pass both
directions before the first agent run is dispatched. An always-passing verifier, an always-failing
verifier, an already-satisfied subject, or a known-good control that cannot run in the selected
environment therefore fails before model cost is incurred.
The public policy is part of the normalized suite and its digest.

The two checks are a minimum operational sanity test, not proof that the verifier implements the
prompt's complete semantics. They do not show that the subject failed for the intended reason or
that important partial implementations are rejected. Evaluators should still review the verifier
independently and exercise representative partial-bad mutations before a controlled experiment.
The preflight is part of the same foreground `eval run`; it does not create an answer file,
reusable receipt, second Eval result, or cross-commit comparison.

Schema v1 and v2 cases cannot be mixed in one suite. Use separate suite files and `--suite` when
both kinds are needed.

## Runtime provisioning

Patch Eval never derives a Python runtime from the caller's `PATH`. It uses a self-contained,
read-only runtime capsule selected by a built-in catalog ID or by an absolute evaluator-owned
`manifest.json` path. Provision a catalog runtime before starting the evaluation:

```sh
agenthub eval runtime install --runtime default
agenthub eval runtime status --runtime default
```

The built-in platform catalog pins an exact gzip release artifact from
[astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone), including
its archive digest. Installation is the only step
that may fetch that artifact. It validates and extracts the capsule into a private,
content-addressed runtime store. Objects live below `objects/sha256/<digest>/manifest.json`, while
catalog IDs resolve through local `refs/<runtime_id>` entries; `status` only inspects local state.
Before an object is published, Agent Hub removes write bits from its manifest and runtime tree,
runs the native self-test against that sealed payload, and atomically renames it into its digest
slot. A catalog reference is accepted only when the slot name, manifest digest, pinned source, and
sealed tree agree.
The store defaults to `${XDG_CACHE_HOME:-~/.cache}/agent-hub-mcp/eval-runtimes` and can be moved
with `AGENT_HUB_EVAL_RUNTIME_DIR`.
`eval run` never downloads or builds a runtime, probes a host Python installation, copies a host
virtual environment, or falls back to `/usr/bin/python3`, Homebrew, user site-packages, or package
caches. A missing, damaged, wrong-platform, or wrong-architecture capsule fails before standards
are collected or a model turn starts.

Each capsule has one `python-runtime-capsule/v1` manifest. Its relative `root` and
`commands.python3` must stay inside the capsule. Its `content_digest` binds the normalized runtime
identity, selected command, pinned source provenance, and validated extracted tree. The
machine-readable contract is
[`schemas/agent-eval-runtime-capsule-v1.schema.json`](../schemas/agent-eval-runtime-capsule-v1.schema.json).
An absolute manifest selector is useful for an evaluator-managed pre-provisioned capsule; it does
not authorize an implicit install or a host-runtime fallback.

The selected runtime ID, Python version, platform, architecture, and content digest are part of the Eval facts.
Controlled baseline/candidate comparisons must require the same runtime content digest in addition
to matching suite, question, model, and effort inputs. The patch suite remains suite schema v2.
Capsule-backed patch runs without verifier preflight emit result schema v3 with a required
`toolchain` object; preflighted runs emit result schema v4 with grader version
`workspace-patch/v2`. Historical result schema v2 remains unchanged rather than being
reinterpreted as capsule-backed.

## Run flow

Run from the repository root:

```sh
agenthub eval run --agent codex --cwd "$PWD" \
  --model gpt-5.6-sol \
  --effort medium \
  --runtime default
```

Model and effort are required. Eval validates both against the live Codex catalog and never chooses
a recommended model, model default, or environment fallback. Optional flags select an external
suite or per-case timeout:

```sh
agenthub eval run \
  --agent codex \
  --cwd "$PWD" \
  --suite .agenthub/evals.json \
  --model gpt-5.6-sol \
  --effort medium \
  --runtime /absolute/path/to/manifest.json \
  --timeout-ms 600000
```

`--runtime` accepts a catalog ID, `default`, or an absolute capsule manifest. Omitting it selects
`default`; the default still must already be installed. The command writes questions and standard
prompts to stderr, reads all human standards from the interactive terminal, and prints one final
JSON result to stdout. It collects every standard before starting the first agent case. Location
suites ask for `path`, `symbol`, and `definition_line`; patch suites ask for an executable verifier
path. A preflight-enabled patch suite additionally asks for one clean committed same-repository
descendant known-good worktree per case, runs every two-sided check, and only then starts agent
cases. Runtime installation is separate from collecting
answers; there is no answer prepare command or answer file. Missing model or effort fails before the
first standard prompt.

The standards and known-good control identities remain in the foreground Eval supervisor's memory.
They are never included in the agent prompt, argv, child environment, ordinary run request, or eval
result. Only canonical answer digests and, for a successful preflighted run, an opaque binding of
the suite, questions, verifier, subject, runtime, timeout, isolation contract, and preflight version
are retained. The binding contains no control path, commit, content, output, or independently
linkable control digest. If the supervisor exits before completion, rerun the evaluation; Eval does
not recover an in-memory oracle or preflight receipt after interruption.

The verifier and known-good lexical paths and their resolved real paths must stay outside the
subject and every runtime capability readable by the child. An overlap fails the entire command
with `unsafe_eval_oracle` rather than asking again: once oracle material is present under a future
child capability, reprompting cannot revoke that readability. No agent run or Eval artifact is
created.

## Isolation contract

The `workspace-readonly/v1` profile is fail-closed:

- Each case starts a new non-resumed, ephemeral Codex session.
- Codex user configuration and exec rules are ignored for the case.
- Codex memories, external memory import, and subagents are disabled.
- Shell commands inherit Codex's `core` environment subset, including the PATH finalized when the
  Codex process is born but excluding provider credentials and namespace bookkeeping. Login-shell
  requests are disabled so login-only startup files cannot replace that environment mid-case.
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
per-case scratch directory after namespace rebinding, even when shell startup changes `TMPDIR`,
`TMP`, or `TEMP`. Agent Hub validates the selected capsule before collecting standards and grants
only its canonical root read-only; it does not grant host Python, Homebrew, developer-tool,
site-package, cache, or home-directory roots. For each case it creates an agent-read-only command
overlay outside both writable roots. The runner prepends that directory only after its cwd-based
namespace rebind, so an ordinary `python3` command resolves to the capsule interpreter without
allowing shell startup to replace it. The child policy disables Python user-site discovery,
`PYTHONPATH`, bytecode writes, and host variables that can replace Python's executable or prefix;
the foreground verifier receives the same Python settings.
Before dispatching a model turn, the supervisor runs an
isolated Python native-standard-library smoke test through `codex sandbox` with the final permission
profile. The smoke test exercises native standard-library modules rather than merely checking
interpreter identity; failure records `runtime_preflight_failed` without starting an agent run.
After a successful preflight, the result includes `pinned-eval-toolchain` in
`isolation.data_read`.

The evaluator resolves and pins the Codex executable—and any simple `/usr/bin/env INTERPRETER`
shebang target—through the same cwd-bound zsh birth used by the formal run. Preflight uses those
pinned executables and an empty temporary `CODEX_HOME`, so user config cannot make its policy differ
from the formal `--ignore-user-config` run. When the cwd-bound shell exposes a real `CODEX_HOME`, a
second fail-closed preflight also uses it so local and authentication-backed managed requirements
can reject the case; this policy gate may be stricter than the formal run when user config adds
restrictions. Private handoff variables are consumed before Codex starts and are not exposed to the
agent; metadata retains the declared capsule capability and runtime command directory, but never
the composed child `PATH` value.

Disposable worktree creation overrides `core.hooksPath` with a private empty directory, so repository
checkout hooks cannot publish the temporary path or mutate external state. Agent Hub records the
patch before verifier execution and removes the worktree afterward.

When verifier preflight is enabled, the supervisor applies the same empty-hook and disposable-copy
discipline to the untouched subject and known-good controls. It invokes the same pinned verifier
with the same capsule-first `PATH`, filtered environment, private `HOME`/`ZDOTDIR`, private temp
directories, and timeout used for final grading. It revalidates pinned inputs around execution and
discards every control copy before dispatch. A preflight failure is a command-level error: Agent Hub
starts no ordinary run and writes no Eval result artifact.

Patch metric collection is best-effort telemetry: an oversized or otherwise unprojectable patch is
reported as `patch.status = "unavailable"` but does not skip or override verifier grading. Worktree
cleanup always attempts both Git deregistration and filesystem removal; a cleanup failure is
reported to the foreground stderr without replacing the completed case result.

The agent sandbox does not extend to verifier execution, including its preflight invocations. The
verifier is evaluator-trusted and may read or change user-accessible files, use the network, and
execute code from a control worktree or code written by the agent with the foreground user's
authority when it invokes repository tests. Its `PATH` starts with the same capsule command overlay,
so an ordinary
`python3` test entrypoint uses the recorded toolchain even though the verifier retains foreground
authority. Verifier startup uses a private `HOME`/`ZDOTDIR` and does not inherit `BASH_ENV` or
namespace rebinding state, preventing its shebang shell from replacing that PATH first. Agent Hub
revalidates the capsule after verification; a mutation makes the case
`invalid/runtime_capsule_changed` and leaves later cases unrun. A background process deliberately
left by the agent or verifier is another known
residual risk: Agent Hub does not kill a persisted process group from stored pid metadata because of
pid-reuse/incorrect-target risk. The verifier copy stays outside the agent permission profile, but
patch eval and verifier preflight are not hostile-code sandboxes. Preflight increases the number of
foreground verifier executions and does not eliminate the risk of running agent-produced code.
Use only trusted, preferably idempotent verifiers and repositories for which executing the tests as
the current user is acceptable. Agent Hub prevents oracle disclosure through its managed child and
result channels; it cannot constrain a malicious foreground verifier from publishing its own data.

## Result and retention

Every completed eval command stores one private `0600` JSON result under
`${AGENT_HUB_EVAL_DIR}` or, by default,
`${XDG_STATE_HOME:-~/.local/state}/agent-hub-mcp/evals/`. The result contains:

- suite, question, answer, workspace, and grader digests;
- the exact commit, agent version, model, effort, and isolation policy;
- for patch suites, the selected runtime ID, Python version, platform, architecture, and capsule
  content digest;
- for preflighted patch suites, the preflight policy and an opaque digest binding the accepted
  suite, questions, verifier, subject, runtime, timeout, and execution contract;
- per-case pass/fail/invalid/error status and the backing ordinary `agent_run_ref`;
- elapsed time, usage, turn/tool counts, and high-confidence observed file-read counts;
- for patch suites, observed write counts, bounded change statistics, patch digest, and verifier
  exit status.

The suite `relative_path` is recorded relative to the evaluated worktree root and may contain `..`
for evaluator-owned external input. The result never stores suite question text. Controlled
cross-commit comparisons should require matching suite, question, and runtime content digests; if
the evaluator modifies or extrapolates questions between runs, the consumer should treat them as
exploratory new cases rather than paired efficiency measurements.
Preflighted comparisons must also match verifier digest, policy/version, timeout, and isolation
contract. Their opaque preflight bindings include the subject identity and therefore are expected
to differ across baseline and candidate.

The eval result does not contain question text, standard answers/verifiers, parsed agent answers,
patch bodies, verifier output, or preflight control paths, commits, contents, outputs, or separate
control digests. The backing ordinary run keeps the ordinary provider-native
prompt and tool transcript under the existing run TTL, so commands and code excerpts observed by
the agent may still be present there; verifier identity, contents, and output never enter that run.

The machine-readable result contracts are
[`schemas/agent-eval-result-v1.schema.json`](../schemas/agent-eval-result-v1.schema.json) and
[`schemas/agent-eval-result-v2.schema.json`](../schemas/agent-eval-result-v2.schema.json) for
historical runs, plus
[`schemas/agent-eval-result-v3.schema.json`](../schemas/agent-eval-result-v3.schema.json) for
ordinary capsule-backed patch runs and
[`schemas/agent-eval-result-v4.schema.json`](../schemas/agent-eval-result-v4.schema.json) for
preflighted patch runs.

Eval results default to the ordinary seven-day run TTL. Override storage or retention with:

```text
AGENT_HUB_EVAL_DIR
AGENT_HUB_EVAL_TTL_SECONDS
AGENT_HUB_EVAL_RUNTIME_DIR
```

Expired result files are removed on the next eval run. Comparison and long-term retention remain
outside Agent Hub. Runtime capsules are provisioned artifacts rather than result-TTL data and are
not removed by Eval result cleanup.

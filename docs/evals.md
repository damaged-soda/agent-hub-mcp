# Repository evaluations

Agent Hub evaluations run one evaluator-selected question suite against one immutable commit. A
suite either asks fresh coding-agent sessions to locate production code or to implement a change
inside disposable worktrees. The suite is evaluator input, not part of the subject: Agent Hub
snapshots and hashes it at command startup, while the evaluated worktree must remain clean and
committed. Agent Hub runs and grades one suite; it does not compare commits, rank runs, or maintain
a long-term benchmark. A consumer such as Cockpit may ingest the resulting facts and choose its own
comparison cohorts.

A verifier preflight may execute the evaluator-trusted grader against disposable control worktrees
before dispatch. It is optional for suite schema v2 and mandatory, under the sandboxed v2 policy,
for schema v3. Those controls are input validation, not additional Eval subjects: no model runs
against them, no work metrics or ranking are produced for them, and one completed Eval result still
describes exactly one subject commit.

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

Suites contain questions plus their versioned public verifier-preflight/toolchain policy, never
oracle material. The policy is optional only where its schema says so.
Expected paths, control identities, immutable source comments, and grader scripts are rejected.
The evaluated worktree must be clean and committed, but the selected suite
does not need to be. `--suite` may select an absolute file anywhere readable by the foreground
evaluator; a relative path resolves from the evaluated worktree root. External suite paths are not
added to the child agent's readable capabilities. The normalized suite is held in supervisor memory,
so edits after command startup do not change the accepted questions or digests. The machine-readable
suite contracts are
[`schemas/agent-eval-suite-v1.schema.json`](../schemas/agent-eval-suite-v1.schema.json),
[`schemas/agent-eval-suite-v2.schema.json`](../schemas/agent-eval-suite-v2.schema.json), and
[`schemas/agent-eval-suite-v3.schema.json`](../schemas/agent-eval-suite-v3.schema.json).

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

Suite schema v3 keeps the `workspace-patch/v1` answer shape but makes the capability contract and
two-sided verifier calibration mandatory:

```json
{
  "schema_version": 3,
  "suite_id": "portable-toolchain-changes",
  "verifier_preflight": "subject-reject-known-good-pass/v2",
  "toolchain_requirements": {
    "kind": "command-smoke/v1",
    "commands": [
      {"name": "git", "argv": ["init", "-b", "main", "."]},
      {"name": "node", "argv": ["-e", "process.exit(0)"]},
      {"name": "python3", "argv": ["--version"]}
    ]
  },
  "cases": [
    {
      "id": "exercise-repository-tooling",
      "prompt": "Implement the change and run the repository test entrypoint.",
      "answer_schema": "workspace-patch/v1"
    }
  ]
}
```

Each requirement names one command exported by the selected generic capsule and supplies its
literal argv smoke; there is no shell interpolation in that declaration. Agent Hub normalizes the
requirements in command-name order, binds them into the suite and capability digests, and runs
every smoke through the final Codex permission profile before collecting verifier paths or
known-good controls. It tests both an empty temporary `CODEX_HOME` and the cwd-bound Codex home when
they differ. A missing command fails with `toolchain_unavailable`; a smoke failure reports
`toolchain_preflight_failed`. Either failure occurs before a model run or Eval result artifact
exists.

The v2 verifier policy retains the v1 negative-subject/positive-known-good semantics, but both
control invocations and final grading run through `codex sandbox` with the same
`workspace-write/v2` capability plan used by the child. The verifier remains evaluator-trusted and
may execute repository or agent-produced code inside that sandbox. The verifier path and copied
body are private oracle material and are added only to the verifier's per-invocation scratch, never
to the model's profile or result.

The generated command overlay is applied only by the sandbox child environment policy. It is never
prepended to the Codex CLI parent process, so Codex startup and workspace discovery cannot execute
an evaluator-supplied capsule command with foreground authority.

Cases from schema v1, v2, and v3 cannot be mixed in one suite. Use separate suite files and
`--suite` when more than one contract is needed. Suite schemas v1/v2 and their preflight behavior
remain unchanged; schema v3 is an opt-in version boundary rather than a reinterpretation.

## Runtime and toolchain provisioning

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

Schema-v3 runs instead require an evaluator-provisioned generic toolchain capsule. Agent Hub ships
no generic toolchain installer or catalog: the evaluator must materialize a capsule for the target
platform and pass its absolute manifest path. `eval run` will not search `PATH`, inspect developer
tools, download packages, copy an installation, or use a host command as a fallback.

```sh
agenthub eval toolchain manifest \
  --directory /absolute/capsule \
  --json '{"toolchain_id":"repo-tools","root":"toolchain","commands":{"git":"bin/git","node":"bin/node","python3":"bin/python3"}}'
chmod -R a-w /absolute/capsule
agenthub eval toolchain status --toolchain /absolute/capsule/manifest.json
```

Before this sequence, the evaluator creates `/absolute/capsule/toolchain` and places every command
and dependency it intends to expose below that root. `eval toolchain manifest` is the supported
manifest writer: it validates the existing relative command map, defaults omitted `platform` and
`arch` to the current host, computes the implementation's byte-exact tree and capsule digests, and
atomically writes `manifest.json`. It does not find, install, download, copy, or seal tool files.
The input accepts only `toolchain_id`, optional `platform`/`arch`, `root`, and `commands`; `kind` and
`content_digest` are generated. After writing, remove write bits from the dedicated capsule
directory and use `eval toolchain status` as the fail-closed readiness check. Re-run the writer only
after deliberately making that directory writable and changing its contents.

An `eval-toolchain-capsule/v1` manifest contains `toolchain_id`, `platform`, `arch`, a contained
relative `root`, a non-empty map from safe public command names to contained relative executable
paths, and `content_digest`. The digest binds the normalized identity, sorted command map, and the
complete validated tree. Roots and commands must be canonical and outside both the evaluated
worktree and its Git common directory; symlinks may resolve only within the root, and regular files
with multiple hard links are rejected.
For `eval run`, the manifest directory, manifest, and full root tree must have no write permission
bits. This is a permission-bit seal plus pre/post digest validation, not an OS-level immutable mount
or protection against every same-user replacement race. The machine-readable contract is
[`schemas/agent-eval-toolchain-capsule-v1.schema.json`](../schemas/agent-eval-toolchain-capsule-v1.schema.json).

`eval toolchain status` checks manifest shape, platform/architecture, containment, executability,
content identity, hardlink safety, and the same permission-bit seal required by `eval run`, without
exposing absolute command paths. The result records the capsule identity, content digest,
platform, architecture, and sorted public command names, never the manifest/root/command paths.

The generic capsule format deliberately does not claim to infer an arbitrary program's dynamic
dependency closure. A tree digest says which capsule files were supplied; successful suite-declared
smokes say that those named command behaviors worked under the final capability plan. Conditional
plugins, subprocesses, dynamically loaded libraries, or unexercised command modes remain the
evaluator's responsibility. Declare representative smokes and provision everything they need
inside the capsule rather than widening the profile to the host.

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

For suite schema v3, replace the legacy runtime selector with the generic absolute toolchain
manifest:

```sh
agenthub eval run \
  --agent codex \
  --cwd "$PWD" \
  --suite /absolute/path/to/evals-v3.json \
  --model gpt-5.6-sol \
  --effort medium \
  --toolchain /absolute/capsule/manifest.json \
  --timeout-ms 600000
```

`--runtime` accepts a catalog ID, `default`, or an absolute capsule manifest. Omitting it selects
`default`; the default still must already be installed. `--toolchain` is required for schema v3,
must be absolute, and is rejected for earlier schemas; schema v3 likewise rejects `--runtime`.
The command writes questions and standard
prompts to stderr, reads all human standards from the interactive terminal, and prints one final
JSON result to stdout. It collects every standard before starting the first agent case. Location
suites ask for `path`, `symbol`, and `definition_line`; patch suites ask for an executable verifier
path. A preflight-enabled patch suite additionally asks for one clean committed same-repository
descendant known-good worktree per case, runs every two-sided check, and only then starts agent
cases. A schema-v3 run first completes every declared capability smoke, then collects the verifier
and known-good standards, completes sandboxed controls, and only then dispatches a model. Runtime
installation is separate from collecting
answers; there is no answer prepare command or answer file. Missing model or effort fails before the
first standard prompt.

The standards and known-good control identities remain in the foreground Eval supervisor's memory.
They are never included in the agent prompt, argv, child environment, ordinary run request, or eval
result. Only canonical answer digests and, for a successful preflighted run, an opaque binding of
the suite, questions, verifier, subject, selected runtime/toolchain, timeout, isolation contract, and preflight version
are retained. The binding contains no control path, commit, content, output, or independently
linkable control digest. If the supervisor exits before completion, rerun the evaluation; Eval does
not recover an in-memory oracle or preflight receipt after interruption.

The verifier and known-good lexical paths and their resolved real paths must stay outside the
subject and every runtime or toolchain capability readable by the child. An overlap fails the entire command
with `unsafe_eval_oracle` rather than asking again: once oracle material is present under a future
child capability, reprompting cannot revoke that readability. No agent run or Eval artifact is
created.

## Optional evaluator-owned patch export

Schema-v3 runs may explicitly pass `--patch-output /absolute/new-directory` to retain
the model's patch for subsequent integration experiments. The directory must not exist,
its parent must exist, and lexical/resolved paths must not overlap the subject, Git common
directory, or child-readable runtime/toolchain capabilities. The supervisor creates it
only after every preflight passes. It is never exposed to the model or verifier sandbox.

Export requires Git with [`--attr-source`](https://git-scm.com/docs/git/2.43.4#Documentation/git.txt---attr-sourcelttree-ishgt) support (validated here with Git 2.50.1). A private Git index/config reads the
subject's object store through alternates; an empty attributes tree disables clean filters,
text encodings, and EOL rewriting during capture. Neither the original index nor its configuration
is modified. The temporary capture metadata is removed after capture.
The patch transforms subject Git blobs into the submitted raw bytes. For repositories using
attribute-based worktree conversion, replay to the subject index and materialize its raw blobs;
a normal checkout or filtered `git add` can transform those bytes again.

For each completed model run, the supervisor captures the patch **before** invoking its
verifier. Export includes tracked edits, deletions and mode changes plus non-ignored untracked
files, including binary content and symbolic links. It does not stage files or run Git clean
filters. Ignored build output and empty directories are excluded; repositories with submodules
and untracked nested repositories are rejected. Capture is bounded to 16 MiB and 1000 changed files;
an unsupported file type or incomplete capture fails the case explicitly. Timeouts and failed
model runs are not exported. A completed model's patch may still fail its verifier: export is
evidence of the submitted change, not an assertion of correctness.

Each patch has a random relative filename, with a SHA-256 byte digest. A final
`manifest.json` (`kind: agent-eval-patch-export/v1`) binds those files to the Eval ID, subject
commit, suite digest, case ID, agent run reference, original metrics patch digest, and final case
status. The export digest covers the replayable patch bytes; the existing metrics digest also
includes its legacy untracked-file hash representation and is not interchangeable. The manifest
contains no verifier/control identity, oracle output, or absolute path. Do not consume an
interrupted export without its final manifest; verify file digests before replaying patches.

Export directories are private (0700), files are private (0600), existing destinations are never
reused, and destination replacement is checked before writes. As with capsule seals, this is not
protection against arbitrary concurrent same-user filesystem races. The evaluator owns retention
and deletion of exported source content; exports are outside Eval TTL cleanup. Eval result schema
v5, child isolation, grading, and the default no-export behavior are unchanged. Cross-run merging,
comparison, and repair scoring remain evaluator-owned.

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

Legacy schema-v2 patch suites use the companion `workspace-write/v1` profile. It keeps every
restriction above but
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

For legacy schema-v2 suites, the agent sandbox does not extend to verifier execution, including its
preflight invocations. The
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

### Capability-bound patch profile

Schema v3 uses `workspace-write/v2`. The supervisor resolves one sealed generic capsule and one
versioned `eval-capability-plan/v1`, then reuses that plan for declared command smokes, model
children, untouched-subject/known-good verifier controls, and final verification. Every role sees
the same read-only capsule root and generated command overlay. `PATH` contains only that overlay,
so a command name cannot fall through to Homebrew, Xcode/Developer Tools, `/usr/bin`, a user
installation, or another host `PATH` entry. The fixed `/bin/sh` used by Agent Hub to enter the
sandbox is part of the explicit minimal platform runtime, not command discovery.

The v2 shell environment uses a private task `HOME`/`ZDOTDIR` and scratch-backed
`TMPDIR`/`TMP`/`TEMP`, fixes Git's global and system config to `/dev/null`, disables Python user-site
and bytecode behavior, and excludes variables that can replace Git, Node, Python, or shell startup
resolution. Command network, `.git` access, memory, session persistence, and subagents remain
disabled. A verifier is copied only after its digest is rechecked and is launched as a no-model
`codex sandbox` command; its control/final invocation receives the disposable workspace and its
private scratch, not foreground user authority. The verifier copy is never readable by a model
turn.

Before standards are collected, each declared `command-smoke/v1` argv runs under this final policy.
Before model dispatch, the v2 verifier must reject an untouched subject copy and accept its pinned
known-good copy under the same policy. The capsule is revalidated around execution; a later change
marks the case `invalid/toolchain_capsule_changed` and leaves later cases unrun. These gates prove
that declared command behaviors were available symmetrically at the tested points. They cannot
statically prove every dynamic library, plugin, helper, conditional branch, or subprocess an
arbitrary test or verifier might select. A successful smoke is therefore evidence for the declared
capability contract, not a proof of a universal dependency closure or complete verifier semantics.

This new policy does not alter historical behavior. Schema-v2 patch suites still use
`workspace-write/v1`, `python-runtime-capsule/v1`, and foreground verifier execution; their results
remain schemas v3/v4 with graders `workspace-patch/v1` or `workspace-patch/v2`. Schema-v1 location
results and historical result schema v2 are likewise unchanged.

## Result and retention

Every completed eval command stores one private `0600` JSON result under
`${AGENT_HUB_EVAL_DIR}` or, by default,
`${XDG_STATE_HOME:-~/.local/state}/agent-hub-mcp/evals/`. The result contains:

- suite, question, answer, workspace, and grader digests;
- the exact commit, agent version, model, effort, and isolation policy;
- for schema-v2 patch suites, the selected runtime ID, Python version, platform, architecture, and
  capsule content digest;
- for schema-v2 preflighted patch suites, the preflight policy and an opaque digest binding the accepted
  suite, questions, verifier, subject, runtime, timeout, and execution contract;
- for schema-v3 patch suites, the generic capsule kind/ID/content/platform/architecture and sorted
  command names, plus the passed capability plan, declared-requirements digest, and sandboxed v2
  verifier binding;
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
Schema-v3 comparisons must additionally require result schema v5, grader `workspace-patch/v3`,
`workspace-write/v2`, matching toolchain content and command identities, matching normalized
requirements, and matching capability-contract inputs. A result older than v5 carries no claim that
the verifier shared the child's generic capability plan and must not be silently upgraded or mixed
into a capability-parity cohort.

The eval result does not contain question text, standard answers/verifiers, parsed agent answers,
patch bodies, verifier output, or preflight control paths, commits, contents, outputs, or separate
control digests. The backing ordinary run keeps the ordinary provider-native
prompt and tool transcript under the existing run TTL, so commands and code excerpts observed by
the agent may still be present there; verifier identity, contents, and output never enter that run.
Result schema v5 also omits the subject's absolute `cwd`; commit and workspace digest identify the
subject, and its CLI artifact reference uses the opaque `eval_run_id` instead of a storage path.
The private backing run still needs absolute capability paths to execute, but redacts v2
`shell_environment_policy.set.*` values from `command.json` after constructing the real command.

The machine-readable result contracts are
[`schemas/agent-eval-result-v1.schema.json`](../schemas/agent-eval-result-v1.schema.json) and
[`schemas/agent-eval-result-v2.schema.json`](../schemas/agent-eval-result-v2.schema.json) for
historical runs, plus
[`schemas/agent-eval-result-v3.schema.json`](../schemas/agent-eval-result-v3.schema.json) for
ordinary capsule-backed patch runs and
[`schemas/agent-eval-result-v4.schema.json`](../schemas/agent-eval-result-v4.schema.json) for
legacy preflighted patch runs, plus
[`schemas/agent-eval-result-v5.schema.json`](../schemas/agent-eval-result-v5.schema.json) for
schema-v3 capability-bound patch runs. Result contracts v1-v4 retain their original meanings.
The v5 schema also accepts the optional CLI-only `artifact` locator
`{"type":"eval-result","eval_run_id":"…"}`. The persisted `0600` result omits that transport
field; both forms otherwise share the same v5 contract, and neither form contains a storage path.

Eval results default to the ordinary seven-day run TTL. Override storage or retention with:

```text
AGENT_HUB_EVAL_DIR
AGENT_HUB_EVAL_TTL_SECONDS
AGENT_HUB_EVAL_RUNTIME_DIR
```

Expired result files are removed on the next eval run. Comparison and long-term retention remain
outside Agent Hub. Runtime capsules are provisioned artifacts rather than result-TTL data and are
not removed by Eval result cleanup.

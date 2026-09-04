# Repository evaluation

For an individual repository navigation or patch evaluation, run the interactive command from the
clean target worktree root:

```sh
agenthub eval runtime install --runtime default
agenthub eval runtime status --runtime default
agenthub eval run --agent codex --cwd "$PWD" \
  --suite /absolute/path/to/evals.json \
  --model gpt-5.6-sol --effort medium \
  --runtime default
```

For a paired baseline/candidate experiment, follow the separate `eval-driven-refactor` Skill; Agent
Hub itself still produces one result for one immutable commit.

The repository may provide `.agenthub/evals.json` as a question-only sample with an optional public
verifier-preflight policy, but the evaluator owns
the selected suite. `--suite` may select an uncommitted file outside the clean subject worktree; do
not place an evaluator-owned suite in that worktree merely to run it. Agent Hub snapshots and
digests the external suite at startup. Model and effort are mandatory and never come from defaults.

- Schema v1 collects the human standard `path`, `symbol`, and `definition_line`, and enforces
  `workspace-readonly/v1`.
- Schema v2 collects one external executable verifier per case, runs the agent in a disposable
  detached worktree under `workspace-write/v1`, and invokes the verifier only after the agent exits.
  A suite may opt into `verifier_preflight: "subject-reject-known-good-pass/v1"`. For each case,
  also provide a clean committed same-repository descendant known-good worktree when prompted.
  Agent Hub first requires the verifier to reject an untouched subject copy and accept the known-good copy for
  every case, completing the whole suite preflight before its first dispatch; failure starts no
  agent run and writes no Eval artifact.

Patch Eval requires a pre-provisioned `python-runtime-capsule/v1`. `--runtime` accepts `default`, a
catalog runtime ID, or an absolute evaluator-owned manifest path. The built-in catalog pins a gzip
artifact from [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone);
only `eval runtime install` may download it.
`eval run` never downloads, discovers, copies, or falls back to a host Python. It validates the
content-addressed capsule, exposes only the capsule root read-only, gives the foreground verifier
the same capsule-first `PATH`, and records its content digest.
Patch inputs remain suite schema v2. Capsule-backed results without verifier preflight use result
schema v3 / `workspace-patch/v1`; preflighted results use v4 / `workspace-patch/v2`. Both require a
`toolchain`; historical result schema v2 remains unchanged. V4 stores an opaque preflight binding,
not control paths, commits, contents, outputs, or separate control digests. Require the toolchain
content digest to match across every controlled baseline/candidate pair.

Standards and external suite paths stay outside child prompts and artifacts. Do not create an
answer file or work around `unsupported_isolation`; Eval requires Codex CLI 0.151.0 or newer.
Verifier and known-good lexical/real paths must stay outside the subject and all child-readable
runtime paths. `unsafe_eval_oracle` is fatal rather than retryable because a later prompt cannot
revoke an already readable oracle path.
Verifier preflight is not a hostile-code sandbox or proof of semantic completeness: the trusted
foreground verifier retains the current user's filesystem and network authority and may execute
control or agent-produced code.

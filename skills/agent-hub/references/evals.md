# Repository evaluation

For an individual repository navigation or patch evaluation, run the interactive command from the
clean target worktree root:

```sh
agenthub eval run --agent codex --cwd "$PWD" \
  --suite /absolute/path/to/evals.json \
  --model gpt-5.6-sol --effort medium
```

For a paired baseline/candidate experiment, follow the separate `eval-driven-refactor` Skill; Agent
Hub itself still produces one result for one immutable commit.

The repository may provide `.agenthub/evals.json` as a question-only sample, but the evaluator owns
the runtime suite. `--suite` may select an uncommitted file outside the clean subject worktree; do
not place an evaluator-owned suite in that worktree merely to run it. Agent Hub snapshots and
digests the external suite at startup. Model and effort are mandatory and never come from defaults.

- Schema v1 collects the human standard `path`, `symbol`, and `definition_line`, and enforces
  `workspace-readonly/v1`.
- Schema v2 collects one external executable verifier per case, runs the agent in a disposable
  detached worktree under `workspace-write/v1`, and invokes the verifier only after the agent exits.

Standards and external suite paths stay outside child prompts and artifacts. Do not create an
answer file or work around `unsupported_isolation`; Eval requires Codex CLI 0.151.0 or newer.

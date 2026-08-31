# Result interpretation

Compare paired cases, not just suite totals. Structural refactors often trade one kind of work for
another, and aggregate numbers can hide a regression in the exact path the refactor was meant to
improve.

## Verify comparability first

Before interpreting a delta, verify that both results used:

- the intended immutable commits and clean worktrees;
- matching suite and question digests;
- the same agent, model, effort, timeout, CLI version, and isolation policy;
- semantically equivalent human standards or patch verifiers;
- fresh, non-resumed sessions without extra readable directories.

Mark the comparison inconclusive when a material control differs. Do not adjust one side after
seeing its result and still describe the pair as controlled.

## Use a metric hierarchy

1. **Correctness:** pass/fail/invalid/error status is the gate. An efficiency gain does not offset a
   wrong location or behavior regression.
2. **Work performed:** compare turns, tool calls, high-confidence file reads, and the breadth of files
   visited. For patch cases also compare writes, changed files/lines, verifier status, and whether the
   agent stayed within the intended ownership boundary.
3. **Cost and elapsed time:** use token/usage facts when available and elapsed time as supporting
   evidence. They are noisier because provider latency and model variation can dominate small
   structural effects.

Prefer a consistent per-case direction over one dramatic aggregate improvement. If only one pair
was run, describe numeric deltas exactly but do not claim statistical significance.

## Inspect the process behind the number

Use each case's backing `agent_run_ref` and the Agent Hub session inspection workflow when a result
is surprising or materially affects the decision. Look for evidence such as:

- broad repository scans before the agent identifies the true entry point;
- repeated backtracking between files or competing owners;
- a lucky unique-keyword hit that bypasses the structure being evaluated;
- edits applied to an adapter or presentation layer when another component owns the behavior;
- changes scattered across unrelated responsibilities;
- tests or verifier feedback doing the navigation the repository structure failed to provide.

Session inspection is explanatory evidence, not an invitation to grade style. Do not penalize a
different but direct route merely because it was not the route the evaluator expected.

## Make the decision explicit

Relate the result to the predeclared hypothesis. A useful summary contains, for each matched case,
correctness, the meaningful work deltas, and one short process observation. Then state whether the
evidence supports, rejects, or cannot decide the refactor.

If the result is inconclusive, choose the smallest remedy: rerun a noisy case, replace an ambiguous
case, or add one task that exercises a missing maintenance shape. Do not keep adding cases until the
desired outcome appears.

---
name: eval-driven-refactor
description: Design, run, and interpret controlled before-and-after coding-agent evaluations for structural repository refactors with Agent Hub. Use when deciding whether reorganizing code improves agent navigation or editing; do not use for ordinary single-run evals, correctness-only testing, or PR review.
---

# Eval-Driven Refactor

Use repository-owned Agent Hub eval cases to make a structural refactor testable. This skill owns
the experimental method, not a new Agent Hub comparison API. Use the bundled `agent-hub` skill for
the exact CLI and isolation contracts.

## Preserve the ownership boundary

- The target repository owns question-only suites such as `.agenthub/evals.json`.
- Agent Hub runs and grades one suite against one immutable commit and stores the private raw result.
- The evaluator supplies source-location standards or external patch verifiers interactively. Never
  put standards, verifier identities, immutable answer comments, or other oracle material in the
  evaluated repository.
- Compare run results in the current task or in the consuming product. Do not add cross-commit
  ranking, long-term benchmark state, or conclusions about repository quality to Agent Hub core.
- Evaluation does not authorize a refactor, production deployment, or access outside the target
  workspace. Keep the repository's normal approval and delivery rules.

## Establish the experiment before measuring

State the structural hypothesis and the decision it should inform. Select semantically equivalent
tasks before inspecting candidate results; otherwise the benchmark can be tuned to the refactor.
Record the baseline and candidate commits plus the agent, model, effort, timeout, suite digest, CLI
version, and isolation policy that must remain controlled.

When authoring or revising cases, read [references/case-design.md](references/case-design.md). Keep
navigation and patch cases in separate suites because their Agent Hub schemas cannot be mixed.

## Run paired evaluations

Use separate clean worktrees checked out at the immutable baseline and candidate commits. From each
worktree root, run the same suite with the same settings:

```sh
agenthub eval run --agent codex --cwd "$PWD"
```

Use `--suite`, `--model`, `--effort`, and `--timeout-ms` only when the experiment specifies them,
and keep them identical across the pair. Enter the correct standard for each commit: the owning
path, symbol, or definition line may legitimately move during a refactor while the task meaning
stays fixed. For patch suites, supply the same verifier semantics for both commits.

Do not add a prepare phase, resume a prior agent session, enable memory, expose extra directories,
or relax isolation. Agent Hub's eval profile already starts fresh sessions with memory and
subagents disabled. Stop and report an incomparable run if the worktree is dirty, the suite or
settings differ, isolation is unsupported, or a standard/verifier is not semantically equivalent.

## Interpret rather than merely score

Read [references/interpretation.md](references/interpretation.md) before comparing results. Apply a
correctness gate first, then compare matched cases and inspect their backing sessions when the
metrics do not explain the outcome. Treat one paired run as directional evidence, not statistical
proof.

Conclude with one of three decisions:

- **Supports the refactor:** correctness is preserved and the predicted navigation or editing
  burden improves without a compensating scope or complexity regression.
- **Does not support the refactor:** correctness regresses or the predicted benefit is absent.
- **Inconclusive:** controls differ, results conflict, or the observed delta is plausibly noise.

Report the evidence per case, material confounders, and the smallest next decision. Repeat only
ambiguous or high-impact cases; do not turn an exploratory loop into an unbounded benchmark effort.

# Case design

Design cases around maintenance intent, not the current repository layout. A case should remain a
fair question if files, symbols, and line numbers move during the proposed refactor.

## Choose the case type

Use `source-location/v1` when the claim is that the new structure helps an agent identify the
production owner of behavior. It measures navigation and explanation only; it is weak evidence for
edit quality.

Use `workspace-patch/v1` when the claim is that the new structure makes a realistic change easier or
safer. Prefer it for deciding whether to continue a large refactor because the external verifier can
check behavior and unintended scope. Keep the verifier outside every agent-readable path and supply
it interactively.

Do not mix the two answer schemas in one suite. When both are useful, create separate question-only
suites and run each pair independently.

## Write layout-independent prompts

A good prompt describes observable intent in the language a maintainer would naturally use. It
does not prescribe a search strategy, name the expected file or symbol, or reveal a unique literal
that turns the task into direct text lookup.

Prefer questions that require following a real control or data path from a public entry point to the
code that owns the decision. The answer should be discoverable from ordinary repository evidence,
not from a planted comment or benchmark-only marker.

Reject or rewrite a case when:

- the prompt says which commands, directories, files, or intermediate symbols to inspect;
- a prompt phrase has one unique textual match that is already the answer;
- it depends on a line number, function name, or variable name remaining unchanged;
- multiple implementations could satisfy the prompt but the standard accepts only one without a
  repository contract that makes it authoritative;
- the candidate changes the requested behavior rather than only its organization;
- the case exists only to reward the proposed structure.

## Cover the structural hypothesis

A small benchmark is more useful when cases exercise different maintenance shapes. Depending on the
refactor, consider:

- tracing from an external entry point to the component that owns a non-obvious decision;
- making a localized behavior change that should remain within one responsibility boundary;
- making a cross-boundary change whose coordination cost the proposed structure is meant to reduce;
- preserving a nearby negative case so a smaller diff is not achieved by silently dropping behavior.

Do not impose a fixed case count. Each case must have a distinct reason to affect the decision.
Remove redundant or ambiguous cases instead of padding the suite.

## Keep standards outside the suite

Repository suites contain prompts and public answer schemas only. For a location case, inspect each
commit and enter its current `path`, `symbol`, and `definition_line` at runtime. Movement between the
baseline and candidate is expected and is not itself a failure.

For a patch case, use an external executable verifier with equivalent assertions across both
commits. It may inject hidden tests and invoke the repository's normal test entrypoint, but it must
not test for the proposed file layout unless that layout is itself the user requirement.

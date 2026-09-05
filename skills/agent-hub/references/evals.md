# Repository evaluation

For an individual repository navigation or patch evaluation, run the interactive command from the
clean target worktree root:

```sh
agenthub eval toolchain manifest \
  --directory /absolute/path/to/toolchain \
  --json '{"toolchain_id":"repo-tools","root":"root","commands":{"git":"bin/git","node":"bin/node","python3":"bin/python3"}}'
chmod -R a-w /absolute/path/to/toolchain
agenthub eval toolchain status --toolchain /absolute/path/to/toolchain/manifest.json
agenthub eval run --agent codex --cwd "$PWD" \
  --suite /absolute/path/to/evals.json \
  --model gpt-5.6-sol --effort medium \
  --toolchain /absolute/path/to/toolchain/manifest.json
```

This is the preferred schema-v3 patch flow. For a source-location suite, omit `--toolchain`; for a
legacy schema-v2 patch suite, keep using its existing `--runtime` flow.

For a paired baseline/candidate experiment, follow the separate `eval-driven-refactor` Skill; Agent
Hub itself still produces one result for one immutable commit.

The repository may provide `.agenthub/evals.json` as a question-only sample with its versioned
public verifier/toolchain policy, but the evaluator owns
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
- Schema v3 remains a `workspace-patch/v1` answer contract, but requires
  `verifier_preflight: "subject-reject-known-good-pass/v2"` and a non-empty
  `toolchain_requirements` of `command-smoke/v1` commands. It runs every declared smoke under the
  final `workspace-write/v2` Codex capability profile, then runs untouched-subject and known-good
  controls before the first model dispatch. Control verifiers, final verifiers, and the child all
  consume the same versioned Codex sandbox capability plan. Any smoke or control failure creates
  neither an ordinary run nor an Eval artifact. Successful runs produce result schema v5 with
  grader `workspace-patch/v3` and a passed `eval-capability-plan/v1`.

Schema v3 requires an evaluator-provisioned `eval-toolchain-capsule/v1` selected by an absolute
manifest path. The manifest maps stable command names to executables under one content-digested
capsule root outside both the subject worktree and its Git common directory. Before `eval run`,
remove all write permission bits from the manifest directory,
manifest, and full capsule tree; regular files must not be hard-linked. `eval toolchain status`
validates the same seal and reports the public identity without exposing local paths. There is
deliberately no toolchain install command, host discovery, download,
copy, or fallback. The evaluator owns capsule construction and distribution.
After assembling the root, use `eval toolchain manifest` to compute the exact digest and write the
manifest before sealing. Its JSON input accepts `toolchain_id`, optional `platform`/`arch`, `root`,
and `commands`; it hashes existing files but never provisions them.

The schema-v3 `PATH` contains only the capsule command overlay, and the task gets a deterministic
HOME/temp and scrubbed language/VCS startup environment with network disabled. A smoke should
exercise the command mode actually needed by the child and verifier, not merely `--version` when
that would miss material behavior. This contract proves symmetry only for declared, successfully
smoked capabilities. Agent Hub does not statically infer closure over shebang interpreters, dynamic
plugins, absolute-path subprocesses, or input-dependent dependencies; include such requirements in
the capsule and suite when they matter.
The overlay is injected only into sandbox children and is never prepended to the Codex parent
process that performs startup or workspace discovery.

Compatibility is unchanged: suite v1/v2, `python-runtime-capsule/v1`, and result v1-v4 retain their
existing behavior. For schema v2, `--runtime` accepts `default`, a catalog runtime ID, or an absolute
evaluator-owned manifest path; only `eval runtime install` may download the pinned catalog Python,
and `eval run` never discovers or falls back to host Python. Capsule-backed schema-v2 results without
verifier preflight use result v3 / `workspace-patch/v1`; preflighted results use v4 /
`workspace-patch/v2`; historical result v2 remains unchanged. V4 stores an opaque preflight binding,
not control paths, commits, contents, outputs, or separate control digests.

For controlled schema-v3 pairs, require the same suite and question digests,
`toolchain.content_digest`, and `capability_plan.contract_digest`, with both plans marked `passed`.
Do not aggregate result v5 with older patch results as if they shared the same verifier trust boundary.
V5 omits the subject `cwd` and returns only an opaque `eval_run_id` artifact reference, so public
and persisted Eval results contain no private absolute path.

To retain actual model patches for evaluator-owned integration, schema v3 accepts
`--patch-output /absolute/new-directory` (existing parent, new destination outside the subject,
Git common directory, and all child-readable runtime/toolchain paths). After preflights pass,
the supervisor privately captures completed model patches before verifier injection, including
non-ignored untracked files and binary changes. A final `agent-eval-patch-export/v1` manifest binds
relative patch files and byte digests to the Eval/subject/suite/case/run and final case status.
Verify those digests before replay; a failed grade is still a failed change. No manifest means an
interrupted, unusable export. Capture failures fail the case. Exports contain source content, are
not subject to Eval TTL cleanup, and remain evaluator-owned. No export path or oracle/control
material enters the child or result schema v5. Agent Hub still does not merge or compare runs.

Standards and external suite paths stay outside child prompts and artifacts. Do not create an
answer file or work around `unsupported_isolation`; Eval requires Codex CLI 0.151.0 or newer.
Verifier and known-good lexical/real paths must stay outside the subject and all child-readable
runtime/toolchain paths. `unsafe_eval_oracle` is fatal rather than retryable because a later prompt cannot
revoke an already readable oracle path.
Schema-v3 sandboxing is not a formal hostile-code proof or proof of verifier semantic completeness;
the verifier may still execute control or agent-produced code within its bounded capability plan.
Legacy schema-v2 verifiers retain the old foreground current-user filesystem and network authority.

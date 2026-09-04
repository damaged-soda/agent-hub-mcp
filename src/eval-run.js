import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cancelAgentRun,
  dispatchToAgent,
  waitAgentRun,
} from "./runs.js";
import { runCommand } from "./adapter-utils.js";
import {
  BIRTH_SHELL,
  buildBirthLaunch,
  pathResolvedShebangName,
} from "./birth-command.js";
import {
  CODEX_AGENT_ID,
  CODEX_EVAL_PERMISSION_PROFILE_NAME,
  CODEX_EVAL_MIN_VERSION,
  codexEvalPermissionArgs,
  parseCodexModelCatalog,
  parseCodexVersion,
  supportsCodexEvalVersion,
} from "./codex-adapter.js";
import { buildAgentEnv } from "./env.js";
import {
  PYTHON_RUNTIME_SELFTEST_ARGS,
  createRuntimeCommandBin,
  resolvePythonRuntimeCapsule,
  validatePythonRuntimeSelftest,
} from "./eval-runtime.js";
import { projectLiveStream } from "./agent-session-core.js";
import { readTextIfExists, runDirFor } from "./fs-store.js";
import {
  PATCH_EVAL_EXECUTION_PROFILE,
  PATCH_EVAL_SUITE_SCHEMA_VERSION,
  READONLY_EVAL_EXECUTION_PROFILE,
  SOURCE_LOCATION_GRADER_VERSION,
  WORKSPACE_PATCH_PREFLIGHT_GRADER_VERSION,
  WORKSPACE_PATCH_GRADER_VERSION,
  WORKSPACE_PATCH_SCHEMA,
  WORKSPACE_PATCH_VERIFIER_PREFLIGHT,
  answerDigest,
  buildEvalPrompt,
  canonicalizeExistingSourceLocation,
  cleanWorkspaceSnapshot,
  evalError,
  gradeSourceLocation,
  loadEvalSuite,
  normalizeExpectedVerifier,
  normalizeExpectedSourceLocation,
  normalizeKnownGoodWorkspace,
  parseSourceLocationOutput,
  sameWorkspaceSnapshot,
  verifierUnchanged,
} from "./eval-protocol.js";
import {
  cleanupExpiredEvalResults,
  evalExpiresAt,
  getEvalRoot,
  writeEvalResult,
} from "./eval-store.js";

const DEFAULT_CASE_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCE_LOCATION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["path", "symbol", "definition_line"],
  properties: {
    path: { type: "string", minLength: 1 },
    symbol: { type: "string", minLength: 1 },
    definition_line: { type: "integer", minimum: 1 },
  },
});
const WORKSPACE_PATCH_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "completed" },
  },
});
const MAX_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_CHANGED_FILES = 1000;
const PATCH_RUNTIME_PREFLIGHT_TIMEOUT_MS = 15000;
const CODEX_DISCOVERY_TIMEOUT_MS = 5000;

export async function runEval(input, io, internal = {}) {
  const explicitModel = explicitEvalSetting(input.model, "model");
  const explicitEffort = explicitEvalSetting(input.effort, "effort");
  await cleanupExpiredEvalResults(internal.env ?? process.env);
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const suite = await loadEvalSuite(cwd, input.suite_path);
  const subject = await cleanWorkspaceSnapshot(cwd);
  const patchEval = suite.schema_version === PATCH_EVAL_SUITE_SCHEMA_VERSION;
  const verifierPreflightEnabled =
    suite.verifier_preflight === WORKSPACE_PATCH_VERIFIER_PREFLIGHT;
  const timeoutMs = input.timeout_ms ?? DEFAULT_CASE_TIMEOUT_MS;
  const requestedProfile = patchEval
    ? PATCH_EVAL_EXECUTION_PROFILE
    : READONLY_EVAL_EXECUTION_PROFILE;
  const agent = await resolveEvalAgent(
    { ...input, model: explicitModel, effort: explicitEffort },
    cwd,
    internal.env ?? process.env,
    requestedProfile,
  );
  const expected = await collectAnswers(suite, subject, agent, io);
  const afterAnswers = await cleanWorkspaceSnapshot(cwd);
  if (!sameWorkspaceSnapshot(subject, afterAnswers)) {
    throw evalError(
      "eval_workspace_changed",
      "Eval workspace changed while standard answers were being collected",
    );
  }
  let verifierPreflight = null;
  if (verifierPreflightEnabled) {
    io.stderr(
      "\nStandard answers accepted; running trusted foreground verifier preflight controls " +
        "with current-user filesystem and network authority.\n",
    );
    verifierPreflight = await preflightVerifierControls({
      suite,
      expected,
      subject,
      agent,
      env: internal.env ?? process.env,
      timeoutMs,
    });
    const afterPreflight = await cleanWorkspaceSnapshot(cwd);
    if (!sameWorkspaceSnapshot(subject, afterPreflight)) {
      throw evalError(
        "eval_workspace_changed",
        "Eval workspace changed while verifier preflight controls were running",
      );
    }
    io.stderr("Verifier preflight controls passed; starting isolated evaluation.\n");
  } else {
    io.stderr("\nStandard answers accepted; starting isolated evaluation.\n");
  }

  const evalRunId = crypto.randomUUID();
  const createdAt = new Date();
  const caseResults = [];
  for (const item of suite.cases) {
    const beforeCase = await cleanWorkspaceSnapshot(cwd);
    if (!sameWorkspaceSnapshot(subject, beforeCase)) {
      caseResults.push(invalidWorkspaceCase(item, expected.get(item.id)));
      break;
    }
    try {
      const runInput = {
        item,
        expected: expected.get(item.id),
        cwd,
        subject,
        agent,
        env: internal.env ?? process.env,
        timeoutMs,
      };
      caseResults.push(item.answer_schema === WORKSPACE_PATCH_SCHEMA
        ? await runPatchCase(runInput)
        : await runSourceLocationCase(runInput));
    } catch (error) {
      caseResults.push(baseCaseResult(item, expected.get(item.id), null, {
        status: "error",
        reason: error?.code ?? "eval_case_error",
        metrics: { telemetry_status: "not-run" },
      }));
    }
    const afterCase = await cleanWorkspaceSnapshot(cwd);
    if (!sameWorkspaceSnapshot(subject, afterCase)) {
      caseResults[caseResults.length - 1] = {
        ...caseResults.at(-1),
        status: "invalid",
        reason: "workspace_changed",
      };
      break;
    }
    if (caseResults.at(-1)?.reason === "runtime_capsule_changed") break;
  }

  const completedAt = new Date();
  const summary = summarizeCases(caseResults, suite.cases.length);
  const executionProfile = patchEval
    ? PATCH_EVAL_EXECUTION_PROFILE
    : READONLY_EVAL_EXECUTION_PROFILE;
  const result = {
    schema_version: patchEval ? (verifierPreflightEnabled ? 4 : 3) : 1,
    kind: "agent-eval-run",
    eval_run_id: evalRunId,
    status: "completed",
    suite: {
      suite_id: suite.suite_id,
      suite_digest: suite.digest,
      relative_path: suite.relative_path,
      case_count: suite.cases.length,
    },
    subject: {
      cwd: subject.root,
      commit: subject.commit,
      workspace_digest: subject.workspace_digest,
    },
    agent: {
      agent_id: agent.agent_id,
      version: agent.version,
      model: agent.model,
      effort: agent.effort,
    },
    ...(patchEval ? { toolchain: publicEvalToolchain(agent.eval_toolchain) } : {}),
    ...(verifierPreflight ? { verifier_preflight: verifierPreflight } : {}),
    isolation: {
      policy: executionProfile,
      enforcement: "codex-permission-profile",
      data_read: [
        "workspace",
        "minimal-runtime",
        "agent-runtime",
        ...(patchEval && agent.eval_toolchain_ready ? ["pinned-eval-toolchain"] : []),
        "private-per-case-scratch",
      ],
      data_write: patchEval
        ? ["disposable-per-case-worktree", "private-per-case-scratch"]
        : ["private-per-case-scratch"],
      git_history: false,
      tool_network: false,
      memory: "off",
      session_persistence: false,
      subagents: false,
    },
    grader_version: patchEval
      ? (verifierPreflightEnabled
          ? WORKSPACE_PATCH_PREFLIGHT_GRADER_VERSION
          : WORKSPACE_PATCH_GRADER_VERSION)
      : SOURCE_LOCATION_GRADER_VERSION,
    cases: caseResults,
    summary,
    created_at: createdAt.toISOString(),
    completed_at: completedAt.toISOString(),
    expires_at: evalExpiresAt(completedAt, internal.env ?? process.env),
  };
  const resultPath = await writeEvalResult(result, internal.env ?? process.env);
  return {
    ...result,
    artifact: { type: "eval-result", path: resultPath },
  };
}

async function resolveEvalAgent(input, cwd, env, executionProfile) {
  if (input.agent_id !== CODEX_AGENT_ID) {
    throw evalError(
      "unsupported_isolation",
      `Eval ${executionProfile} currently supports only ${CODEX_AGENT_ID}`,
    );
  }
  const birthContext = await resolveCodexBirthContext(cwd, env);
  const versionResult = await runCodexInBirthContext(
    birthContext.executable,
    birthContext.interpreter,
    ["--version"],
    cwd,
    env,
  );
  const version = (versionResult.stdout || versionResult.stderr).trim();
  if (versionResult.error || versionResult.code !== 0 || !parseCodexVersion(version)) {
    const reason = versionResult.error?.message ||
      versionResult.stderr.trim() ||
      versionResult.stdout.trim() ||
      `exit ${versionResult.code}`;
    throw evalError(
      "agent_unavailable",
      `Codex CLI is not available in the evaluated cwd: ${reason}`,
    );
  }
  if (!supportsCodexEvalVersion(version)) {
    throw evalError(
      "unsupported_isolation",
      `Codex Eval requires codex-cli ${CODEX_EVAL_MIN_VERSION.join(".")} or newer`,
    );
  }
  const modelResult = await runCodexInBirthContext(
    birthContext.executable,
    birthContext.interpreter,
    ["debug", "models"],
    cwd,
    env,
  );
  let models;
  try {
    if (modelResult.error || modelResult.code !== 0) throw new Error(
      modelResult.error?.message || modelResult.stderr.trim() || `exit ${modelResult.code}`,
    );
    models = parseCodexModelCatalog(modelResult.stdout);
    if (models.length === 0) throw new Error("empty catalog");
  } catch (error) {
    throw evalError(
      "eval_model_unavailable",
      `Codex model discovery is unavailable: ${error.message}`,
    );
  }
  const model = models.find((item) => item.id === input.model);
  if (!model) {
    throw evalError("eval_model_unavailable", `Codex model is not available: ${input.model}`);
  }
  const effort = input.effort;
  if (
    effort &&
    Array.isArray(model.supported_efforts) &&
    model.supported_efforts.length > 0 &&
    !model.supported_efforts.includes(effort)
  ) {
    throw evalError(
      "invalid_eval_effort",
      `Effort ${effort} is not supported by model ${model.id}`,
    );
  }
  const evalToolchain = executionProfile === PATCH_EVAL_EXECUTION_PROFILE
    ? await resolvePythonRuntimeCapsule(input.runtime ?? "default", env, {
        forbidden_roots: [cwd],
      })
    : null;
  const runtime = await codexRuntimeReadPaths(
    birthContext.executable,
    birthContext.interpreter,
    evalToolchain,
    cwd,
  );
  return {
    agent_id: input.agent_id,
    version,
    model: model.id,
    effort,
    agent_executable: runtime.agent_executable,
    agent_interpreter: runtime.agent_interpreter,
    agent_code_home: birthContext.code_home,
    runtime_read_paths: runtime.paths,
    eval_toolchain: runtime.eval_toolchain,
    eval_toolchain_ready: false,
  };
}

function explicitEvalSetting(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw evalError("invalid_eval_request", `Eval requires an explicit ${name}`);
  }
  return value.trim();
}

async function resolveCodexBirthContext(cwd, env) {
  const result = await runCommand(BIRTH_SHELL, [
    "-c",
    'resolved="${commands[codex]:-}"; [[ "$resolved" = /* && -x "$resolved" ]] || exit 127; ' +
      'print -r -- "$resolved"; print -r -- "${CODEX_HOME:-$HOME/.codex}"',
  ], {
    cwd,
    env: birthEnvironment(env),
    timeoutMs: CODEX_DISCOVERY_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  });
  if (result.error || result.code !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.code}`;
    throw evalError("agent_unavailable", `Codex CLI could not be resolved at the evaluated cwd: ${detail}`);
  }
  const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 2 || !path.isAbsolute(lines[0])) {
    throw evalError(
      "agent_unavailable",
      "Codex CLI resolution at the evaluated cwd returned invalid output",
    );
  }
  const executable = await validateBirthExecutable(lines[0], cwd, "Codex CLI");
  let interpreterName;
  try {
    interpreterName = pathResolvedShebangName(executable);
  } catch {
    throw evalError("agent_unavailable", "Resolved Codex CLI has an unsupported env shebang");
  }
  const interpreter = interpreterName
    ? await resolveNamedBirthExecutable(interpreterName, cwd, env)
    : null;
  if (!path.isAbsolute(lines[1])) {
    throw evalError(
      "agent_unavailable",
      "Codex home resolved at the evaluated cwd must be absolute",
    );
  }
  const codeHome = path.resolve(lines[1]);
  return { executable, interpreter, code_home: codeHome };
}

async function resolveNamedBirthExecutable(name, cwd, env) {
  const result = await runCommand(BIRTH_SHELL, [
    "-c",
    'resolved="${commands[$0]:-}"; [[ "$resolved" = /* && -x "$resolved" ]] || exit 127; ' +
      'print -r -- "$resolved"',
    name,
  ], {
    cwd,
    env: birthEnvironment(env),
    timeoutMs: CODEX_DISCOVERY_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  });
  if (result.error || result.code !== 0) {
    throw evalError(
      "agent_unavailable",
      `Codex CLI interpreter ${name} could not be resolved at the evaluated cwd`,
    );
  }
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  if (lines.length !== 1 || !path.isAbsolute(lines[0])) {
    throw evalError("agent_unavailable", `Codex CLI interpreter ${name} resolved invalid output`);
  }
  const interpreter = await validateBirthExecutable(lines[0], cwd, `Codex CLI interpreter ${name}`);
  try {
    if (pathResolvedShebangName(interpreter)) {
      throw new Error("nested env shebang");
    }
  } catch {
    throw evalError(
      "agent_unavailable",
      `Codex CLI interpreter ${name} must not use an env shebang`,
    );
  }
  return interpreter;
}

async function validateBirthExecutable(value, cwd, label) {
  const lexical = path.resolve(value);
  let real;
  let realCwd;
  try {
    real = await fsp.realpath(lexical);
    realCwd = await fsp.realpath(cwd);
    await fsp.access(real, fsConstants.X_OK);
    if (!(await fsp.stat(real)).isFile()) throw new Error("not a file");
  } catch {
    throw evalError("agent_unavailable", `${label} is not an executable file`);
  }
  if ([lexical, real].some((item) =>
    pathIsInside(item, realCwd) || pathIsInside(realCwd, item),
  )) {
    throw evalError("unsupported_isolation", `${label} overlaps the evaluated workspace`);
  }
  return real;
}

function runCodexInBirthContext(executable, interpreter, args, cwd, env) {
  const birth = buildBirthLaunch(
    { command: executable, args },
    birthEnvironment(env),
    { path_interpreter: interpreter },
  );
  return runCommand(birth.launcher[0], birth.launcher.slice(1), {
    cwd,
    env: birth.env,
    timeoutMs: CODEX_DISCOVERY_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024,
  });
}

function birthEnvironment(env) {
  return {
    ...buildAgentEnv(env),
    NS_REBIND: "1",
  };
}

async function codexRuntimeReadPaths(
  selectedExecutable,
  selectedInterpreter,
  evalToolchain = null,
  deniedRoot = null,
) {
  const paths = new Set();
  let agentExecutable;
  try {
    await fsp.access(selectedExecutable, fsConstants.X_OK);
    agentExecutable = await fsp.realpath(selectedExecutable);
    if (!(await fsp.stat(agentExecutable)).isFile()) throw new Error("not a file");
  } catch {
    throw evalError("unsupported_isolation", "Codex executable path could not be resolved");
  }
  if (
    deniedRoot &&
    (pathIsInside(agentExecutable, deniedRoot) || pathIsInside(deniedRoot, agentExecutable))
  ) {
    throw evalError("unsupported_isolation", "Codex executable overlaps the evaluated workspace");
  }
  paths.add(path.dirname(agentExecutable));
  let agentInterpreter = null;
  if (selectedInterpreter) {
    try {
      await fsp.access(selectedInterpreter, fsConstants.X_OK);
      agentInterpreter = await fsp.realpath(selectedInterpreter);
      if (!(await fsp.stat(agentInterpreter)).isFile()) throw new Error("not a file");
    } catch {
      throw evalError("unsupported_isolation", "Codex interpreter path could not be resolved");
    }
    if (
      deniedRoot &&
      (pathIsInside(agentInterpreter, deniedRoot) || pathIsInside(deniedRoot, agentInterpreter))
    ) {
      throw evalError("unsupported_isolation", "Codex interpreter overlaps the evaluated workspace");
    }
    paths.add(agentInterpreter);
  }
  const standaloneRoot = ancestorNamed(agentExecutable, "standalone");
  if (standaloneRoot) paths.add(standaloneRoot);
  if (evalToolchain) {
    paths.add(evalToolchain.root);
    for (const item of evalToolchain.read_paths) paths.add(item);
  }
  return {
    agent_executable: agentExecutable,
    agent_interpreter: agentInterpreter,
    paths: Array.from(paths).sort(),
    eval_toolchain: evalToolchain,
  };
}

function ancestorNamed(value, name) {
  let current = path.resolve(value);
  while (true) {
    if (path.basename(current) === name) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function collectAnswers(suite, subject, agent, io) {
  if (typeof io?.readLine !== "function") {
    throw evalError("interactive_eval_required", "Eval run requires an interactive terminal");
  }
  const answers = new Map();
  for (const [index, item] of suite.cases.entries()) {
    io.stderr(`\n[${index + 1}/${suite.cases.length}] ${item.id}\n${item.prompt}\n\n`);
    while (true) {
      try {
        if (item.answer_schema === WORKSPACE_PATCH_SCHEMA) {
          const verifierPath = await io.readLine("standard verifier path: ");
          const verifier = await normalizeExpectedVerifier(
            verifierPath,
            subject.root,
            agent.runtime_read_paths,
          );
          if (suite.verifier_preflight === WORKSPACE_PATCH_VERIFIER_PREFLIGHT) {
            const controlPath = await io.readLine("known-good control workspace: ");
            const knownGood = await normalizeKnownGoodWorkspace(
              controlPath,
              subject,
              agent.runtime_read_paths,
            );
            const controlVerifier = await normalizeExpectedVerifier(
              verifierPath,
              knownGood.root,
              agent.runtime_read_paths,
            );
            if (
              controlVerifier.path !== verifier.path ||
              controlVerifier.content_digest !== verifier.content_digest
            ) {
              throw evalError(
                "invalid_eval_answer",
                "Standard verifier resolved differently for the known-good control",
              );
            }
            verifier.known_good = knownGood;
          }
          answers.set(item.id, verifier);
        } else {
          const raw = {
            path: await io.readLine("standard path: "),
            symbol: await io.readLine("standard symbol: "),
            definition_line: Number(await io.readLine("standard definition line: ")),
          };
          answers.set(item.id, await normalizeExpectedSourceLocation(raw, subject.root));
        }
        break;
      } catch (error) {
        if (error?.code !== "invalid_eval_answer") throw error;
        io.stderr(`Invalid standard answer: ${error.message}\nPlease enter this case again.\n`);
      }
    }
  }
  return answers;
}

async function preflightVerifierControls({
  suite,
  expected,
  subject,
  agent,
  env,
  timeoutMs,
}) {
  const cases = [];
  for (const item of suite.cases) {
    const standard = expected.get(item.id);
    if (!standard?.known_good) {
      throw evalError(
        "verifier_preflight_failed",
        `Verifier preflight for ${item.id} is missing a known-good control`,
      );
    }
    const currentKnownGood = await cleanWorkspaceSnapshot(standard.known_good.root);
    if (!sameWorkspaceSnapshot(standard.known_good, currentKnownGood)) {
      throw evalError(
        "verifier_preflight_failed",
        `Known-good control changed before verifier preflight for ${item.id}`,
      );
    }
    if (!await verifierUnchanged(standard)) {
      throw evalError(
        "verifier_preflight_failed",
        `Standard verifier changed before preflight for ${item.id}`,
      );
    }

    const negative = await runVerifierControl({
      expected: standard,
      subject,
      repositoryRoot: subject.root,
      agent,
      env,
      timeoutMs,
      preflightToolchain: true,
    });
    assertVerifierControl(item, "subject", "fail", negative);
    await assertPinnedEvalToolchain(agent.eval_toolchain, env, subject.root);

    const positive = await runVerifierControl({
      expected: standard,
      subject: standard.known_good,
      repositoryRoot: subject.root,
      agent,
      env,
      timeoutMs,
      preflightToolchain: false,
    });
    assertVerifierControl(item, "known-good control", "pass", positive);
    await assertPinnedEvalToolchain(agent.eval_toolchain, env, subject.root);

    const afterKnownGood = await cleanWorkspaceSnapshot(standard.known_good.root);
    if (!sameWorkspaceSnapshot(standard.known_good, afterKnownGood)) {
      throw evalError(
        "verifier_preflight_failed",
        `Known-good control changed during verifier preflight for ${item.id}`,
      );
    }
    cases.push({
      case_id: item.id,
      question_digest: item.question_digest,
      answer_digest: answerDigest({
        kind: WORKSPACE_PATCH_SCHEMA,
        verifier_digest: standard.content_digest,
      }),
    });
  }
  return {
    kind: WORKSPACE_PATCH_VERIFIER_PREFLIGHT,
    status: "passed",
    binding_digest: answerDigest({
      kind: WORKSPACE_PATCH_VERIFIER_PREFLIGHT,
      grader_version: WORKSPACE_PATCH_PREFLIGHT_GRADER_VERSION,
      suite_digest: suite.digest,
      subject_workspace_digest: subject.workspace_digest,
      runtime_content_digest: agent.eval_toolchain.content_digest,
      execution_profile: PATCH_EVAL_EXECUTION_PROFILE,
      timeout_ms: timeoutMs,
      cases,
    }),
  };
}

async function runVerifierControl({
  expected,
  subject,
  repositoryRoot,
  agent,
  env,
  timeoutMs,
  preflightToolchain,
}) {
  const disposable = await createDisposableWorktree(subject, repositoryRoot);
  const scratchPath = path.join(disposable.root, "scratch");
  let runtimeBin = null;
  try {
    await fsp.mkdir(scratchPath, { mode: 0o700 });
    await assertPinnedEvalToolchain(agent.eval_toolchain, env, subject.root);
    try {
      runtimeBin = await createRuntimeCommandBin(disposable.root, {
        python3: agent.eval_toolchain.commands.python3,
      });
    } catch {
      throw evalError(
        "runtime_preflight_failed",
        "Pinned Python runtime capsule could not be prepared for verifier preflight",
      );
    }
    if (preflightToolchain) {
      const schemaPath = path.join(scratchPath, "workspace-patch.schema.json");
      await fsp.writeFile(schemaPath, `${JSON.stringify(WORKSPACE_PATCH_OUTPUT_SCHEMA)}\n`, {
        mode: 0o600,
      });
      const executionProfile = patchExecutionProfile({
        agent,
        runtimeBin,
        schemaPath,
        scratchPath,
      });
      await preflightPatchExecution({
        agent,
        cwd: disposable.workspace,
        disposable,
        env,
        executionProfile,
      });
      agent.eval_toolchain_ready = true;
    }
    return await runVerifier(
      expected,
      disposable.workspace,
      env,
      timeoutMs,
      runtimeBin,
    );
  } finally {
    if (runtimeBin) await fsp.chmod(runtimeBin, 0o700).catch(() => undefined);
    await removeDisposableWorktree(repositoryRoot, disposable);
  }
}

function assertVerifierControl(item, label, expectedStatus, actual) {
  if (actual.status === expectedStatus) return;
  const exit = actual.metrics?.exit_code === null || actual.metrics?.exit_code === undefined
    ? "unknown"
    : actual.metrics.exit_code;
  throw evalError(
    "verifier_preflight_failed",
    `Verifier preflight for ${item.id} expected ${label} to ${expectedStatus}, ` +
      `but got ${actual.status} (${actual.reason}, exit ${exit})`,
  );
}

async function runSourceLocationCase({ item, expected, cwd, agent, timeoutMs }) {
  const scratchPath = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-eval-case-"));
  await fsp.chmod(scratchPath, 0o700).catch(() => undefined);
  const schemaPath = path.join(scratchPath, "source-location.schema.json");
  await fsp.writeFile(schemaPath, `${JSON.stringify(SOURCE_LOCATION_OUTPUT_SCHEMA)}\n`, {
    mode: 0o600,
  });
  let accepted;
  let snapshot;
  try {
    accepted = await dispatchToAgent(
      {
        agent_id: agent.agent_id,
        cwd,
        prompt: buildEvalPrompt(item),
        metadata: {
          model: agent.model,
          codex: agent.effort ? { effort: agent.effort } : {},
        },
      },
      {
        execution_profile: {
          kind: READONLY_EVAL_EXECUTION_PROFILE,
          scratch_path: scratchPath,
          output_schema_path: schemaPath,
          agent_executable: agent.agent_executable,
          agent_interpreter: agent.agent_interpreter,
          runtime_read_paths: agent.runtime_read_paths,
          path_prepend: [],
        },
      },
    );
    snapshot = await waitAgentRun({
      run_ref: accepted.run_ref,
      timeout_ms: timeoutMs,
      poll_interval_ms: 250,
    });
    if (snapshot.timed_out) {
      const cancelled = await cancelAgentRun({
        run_ref: accepted.run_ref,
        reason: "eval case timed out",
        actor: "agenthub-eval",
      });
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "error",
        reason: "timeout",
        metrics: await evalMetrics(accepted.run_ref, cancelled, cwd),
      });
    }
    if (snapshot.status !== "completed") {
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "error",
        reason: snapshot.error?.code ?? snapshot.status,
        metrics: await evalMetrics(accepted.run_ref, snapshot, cwd),
      });
    }
    let actual;
    try {
      actual = await canonicalizeExistingSourceLocation(
        parseSourceLocationOutput(snapshot.content?.[0]?.text ?? ""),
        cwd,
      );
    } catch (error) {
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "fail",
        reason: error.code ?? "invalid_agent_output",
        metrics: await evalMetrics(accepted.run_ref, snapshot, cwd),
      });
    }
    return baseCaseResult(item, expected, accepted.run_ref, {
      status: gradeSourceLocation(expected, actual) ? "pass" : "fail",
      reason: gradeSourceLocation(expected, actual) ? "exact_match" : "incorrect",
      metrics: await evalMetrics(accepted.run_ref, snapshot, cwd),
    });
  } finally {
    await fsp.rm(scratchPath, { recursive: true, force: true });
  }
}

async function runPatchCase({ item, expected, subject, agent, env, timeoutMs }) {
  const disposable = await createDisposableWorktree(subject);
  const scratchPath = path.join(disposable.root, "scratch");
  const schemaPath = path.join(scratchPath, "workspace-patch.schema.json");
  let accepted;
  let runtimeBin = null;
  try {
    await fsp.mkdir(scratchPath, { mode: 0o700 });
    await fsp.writeFile(schemaPath, `${JSON.stringify(WORKSPACE_PATCH_OUTPUT_SCHEMA)}\n`, {
      mode: 0o600,
    });
    if (!await verifierUnchanged(expected)) {
      return baseCaseResult(item, expected, null, {
        status: "invalid",
        reason: "verifier_changed",
        metrics: { telemetry_status: "not-run" },
      });
    }
    await assertPinnedEvalToolchain(agent.eval_toolchain, env, subject.root);
    try {
      runtimeBin = await createRuntimeCommandBin(disposable.root, {
        python3: agent.eval_toolchain.commands.python3,
      });
    } catch {
      throw evalError(
        "runtime_preflight_failed",
        "Pinned Python runtime capsule could not be prepared for the isolated child",
      );
    }
    const executionProfile = patchExecutionProfile({
      agent,
      runtimeBin,
      schemaPath,
      scratchPath,
    });
    await preflightPatchExecution({
      agent,
      cwd: disposable.workspace,
      disposable,
      env,
      executionProfile,
    });
    agent.eval_toolchain_ready = true;
    accepted = await dispatchToAgent(
      {
        agent_id: agent.agent_id,
        cwd: disposable.workspace,
        prompt: buildEvalPrompt(item),
        metadata: {
          model: agent.model,
          codex: agent.effort ? { effort: agent.effort } : {},
        },
      },
      {
        execution_profile: executionProfile,
      },
    );
    const snapshot = await waitAgentRun({
      run_ref: accepted.run_ref,
      timeout_ms: timeoutMs,
      poll_interval_ms: 250,
    });
    if (snapshot.timed_out) {
      const cancelled = await cancelAgentRun({
        run_ref: accepted.run_ref,
        reason: "eval case timed out",
        actor: "agenthub-eval",
      });
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "error",
        reason: "timeout",
        metrics: await patchEvalMetrics(accepted.run_ref, cancelled, disposable.workspace),
      });
    }
    if (snapshot.status !== "completed") {
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "error",
        reason: snapshot.error?.code ?? snapshot.status,
        metrics: await patchEvalMetrics(accepted.run_ref, snapshot, disposable.workspace),
      });
    }
    const metrics = await patchEvalMetrics(accepted.run_ref, snapshot, disposable.workspace);
    if (!await verifierUnchanged(expected)) {
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "invalid",
        reason: "verifier_changed",
        metrics,
      });
    }
    const verification = await runVerifier(
      expected,
      disposable.workspace,
      env,
      timeoutMs,
      runtimeBin,
    );
    metrics.verifier = verification.metrics;
    try {
      await assertPinnedEvalToolchain(agent.eval_toolchain, env, subject.root);
    } catch {
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "invalid",
        reason: "runtime_capsule_changed",
        metrics,
      });
    }
    return baseCaseResult(item, expected, accepted.run_ref, {
      status: verification.status,
      reason: verification.reason,
      metrics,
    });
  } finally {
    if (runtimeBin) {
      await fsp.chmod(runtimeBin, 0o700).catch(() => undefined);
    }
    try {
      await removeDisposableWorktree(subject.root, disposable);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        event: "eval_disposable_worktree_cleanup_failed",
        code: error?.code ?? "eval_cleanup_error",
        message: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
  }
}

function patchExecutionProfile({ agent, runtimeBin, schemaPath, scratchPath }) {
  return {
    kind: PATCH_EVAL_EXECUTION_PROFILE,
    scratch_path: scratchPath,
    output_schema_path: schemaPath,
    agent_executable: agent.agent_executable,
    agent_interpreter: agent.agent_interpreter,
    runtime_read_paths: Array.from(new Set([
      ...agent.runtime_read_paths,
      runtimeBin,
    ])).sort(),
    path_prepend: [runtimeBin],
  };
}

async function preflightPatchExecution({ agent, cwd, disposable, env, executionProfile }) {
  try {
    const preflightCodexHome = path.join(disposable.root, "preflight-codex-home");
    await fsp.mkdir(preflightCodexHome, { mode: 0o700 });
    await preflightPatchToolchain({
      codexHome: preflightCodexHome,
      cwd,
      env,
      executionProfile,
      runtime: agent.eval_toolchain,
    });
    if (agent.agent_code_home) {
      await preflightPatchToolchain({
        codexHome: agent.agent_code_home,
        cwd,
        env,
        executionProfile,
        runtime: agent.eval_toolchain,
      });
    }
  } catch {
    throw runtimePreflightError();
  }
}

async function preflightPatchToolchain({ codexHome, cwd, env, executionProfile, runtime }) {
  const command = {
    command: executionProfile.agent_executable,
    args: [
      "sandbox",
      "--include-managed-config",
      "-P",
      CODEX_EVAL_PERMISSION_PROFILE_NAME,
      "-C",
      cwd,
      ...codexEvalPermissionArgs(executionProfile),
      "--",
      "/bin/sh",
      "-c",
      'exec python3 "$@"',
      "agenthub-runtime-preflight",
      ...PYTHON_RUNTIME_SELFTEST_ARGS,
    ],
  };
  const birth = buildBirthLaunch(command, {
    ...birthEnvironment(env),
    TMPDIR: executionProfile.scratch_path,
    TMP: executionProfile.scratch_path,
    TEMP: executionProfile.scratch_path,
  }, {
    path_interpreter: executionProfile.agent_interpreter,
    path_prepend: executionProfile.path_prepend,
    post_birth_env: {
      CODEX_HOME: codexHome,
      TMPDIR: executionProfile.scratch_path,
      TMP: executionProfile.scratch_path,
      TEMP: executionProfile.scratch_path,
    },
  });
  let result;
  try {
    result = await runCommand(birth.launcher[0], birth.launcher.slice(1), {
      cwd,
      env: birth.env,
      timeoutMs: PATCH_RUNTIME_PREFLIGHT_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
  } catch {
    throw runtimePreflightError();
  }
  if (result.error || result.code !== 0) throw runtimePreflightError();
  try {
    await validatePythonRuntimeSelftest(result.stdout, runtime);
  } catch {
    throw runtimePreflightError();
  }
}

function runtimePreflightError() {
  return evalError(
    "runtime_preflight_failed",
    "Pinned Python runtime capsule is unavailable in the isolated child profile",
  );
}

async function assertPinnedEvalToolchain(expected, env, forbiddenRoot) {
  let current;
  try {
    current = await resolvePythonRuntimeCapsule(expected.manifest_path, env, {
      forbidden_roots: [forbiddenRoot],
      require_sealed: expected.sealed === true,
    });
  } catch {
    throw runtimePreflightError();
  }
  const projection = (runtime) => ({
    kind: runtime.kind,
    runtime_id: runtime.runtime_id,
    python_version: runtime.python_version,
    platform: runtime.platform,
    arch: runtime.arch,
    content_digest: runtime.content_digest,
    manifest_path: runtime.manifest_path,
    root: runtime.root,
    python3: runtime.commands.python3,
    source: runtime.source ?? null,
    sealed: runtime.sealed === true,
  });
  if (JSON.stringify(projection(current)) !== JSON.stringify(projection(expected))) {
    throw runtimePreflightError();
  }
}

async function patchEvalMetrics(runRef, snapshot, cwd) {
  const metrics = await evalMetrics(runRef, snapshot, cwd, { includeWrites: true });
  try {
    metrics.patch = await workspacePatchSummary(cwd);
    return metrics;
  } catch (error) {
    return {
      ...metrics,
      patch: {
        status: "unavailable",
        reason: error?.code ?? "patch_projection_error",
      },
    };
  }
}

async function runVerifier(expected, cwd, env, timeoutMs, runtimeBin) {
  const verificationParent = path.join(getEvalRoot(env), ".verifier-scratch");
  await fsp.mkdir(verificationParent, { recursive: true, mode: 0o700 });
  await fsp.chmod(verificationParent, 0o700).catch(() => undefined);
  const realVerificationParent = await fsp.realpath(verificationParent);
  if (pathIsInside(realVerificationParent, cwd)) {
    throw evalError(
      "invalid_eval_storage",
      "Eval verifier scratch must stay outside the evaluated workspace",
    );
  }
  const verificationRoot = await fsp.mkdtemp(path.join(realVerificationParent, "case-"));
  await fsp.chmod(verificationRoot, 0o700).catch(() => undefined);
  const verifierPath = path.join(verificationRoot, "verifier");
  const verifierTmp = path.join(verificationRoot, "tmp");
  try {
    const body = await fsp.readFile(expected.path);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    if (digest !== expected.content_digest) {
      return {
        status: "invalid",
        reason: "verifier_changed",
        metrics: { status: "error", exit_code: null, elapsed_ms: 0 },
      };
    }
    await fsp.mkdir(verifierTmp, { mode: 0o700 });
    const verifierHome = path.join(verificationRoot, "home");
    await fsp.mkdir(verifierHome, { mode: 0o700 });
    await fsp.writeFile(verifierPath, body, { mode: 0o700 });
    await fsp.chmod(verifierPath, 0o700);
    const startedAt = Date.now();
    const verifierEnv = verifierEnvironment(env);
    verifierEnv.PATH = [runtimeBin, verifierEnv.PATH || "/usr/bin:/bin"].join(path.delimiter);
    const result = await runCommand(verifierPath, [], {
      cwd,
      env: {
        ...verifierEnv,
        AGENT_HUB_EVAL_WORKSPACE: cwd,
        HOME: verifierHome,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONEXECUTABLE: "",
        PYTHONHOME: "",
        PYTHONNOUSERSITE: "1",
        PYTHONPATH: "",
        PYTHONPLATLIBDIR: "",
        TMPDIR: verifierTmp,
        TMP: verifierTmp,
        TEMP: verifierTmp,
        ZDOTDIR: verifierHome,
        __PYVENV_LAUNCHER__: "",
      },
      timeoutMs,
      captureOutput: false,
    });
    const metrics = {
      status: result.error ? "error" : result.code === 0 ? "passed" : "failed",
      exit_code: Number.isInteger(result.code) ? result.code : null,
      elapsed_ms: Date.now() - startedAt,
    };
    if (result.error) {
      return { status: "error", reason: "verifier_error", metrics };
    }
    return result.code === 0
      ? { status: "pass", reason: "verifier_passed", metrics }
      : { status: "fail", reason: "verifier_failed", metrics };
  } finally {
    await fsp.rm(verificationRoot, { recursive: true, force: true });
  }
}

function publicEvalToolchain(runtime) {
  return {
    kind: runtime.kind,
    runtime_id: runtime.runtime_id,
    python_version: runtime.python_version,
    content_digest: runtime.content_digest,
    platform: runtime.platform,
    arch: runtime.arch,
  };
}

function verifierEnvironment(source) {
  const allowed = [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SHELL",
    "USER",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => typeof source?.[key] === "string")
      .map((key) => [key, source[key]]),
  );
}

async function createDisposableWorktree(subject, repository = subject.root) {
  const prefix = `.agenthub-eval-${path.basename(subject.root)}-`;
  const root = await fsp.mkdtemp(path.join(path.dirname(subject.root), prefix));
  await fsp.chmod(root, 0o700).catch(() => undefined);
  const workspace = path.join(root, "workspace");
  const hooks = path.join(root, "empty-hooks");
  try {
    await fsp.mkdir(hooks, { mode: 0o700 });
    await checkedGit(repository, [
      "-c",
      `core.hooksPath=${hooks}`,
      "worktree",
      "add",
      "--detach",
      workspace,
      subject.commit,
    ]);
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true });
    throw error;
  }
  return { root, workspace };
}

async function removeDisposableWorktree(repository, disposable) {
  let gitError = null;
  let fileError = null;
  try {
    await checkedGit(repository, ["worktree", "remove", "--force", disposable.workspace]);
  } catch (error) {
    gitError = error;
  }
  try {
    await fsp.rm(disposable.root, { recursive: true, force: true });
  } catch (error) {
    fileError = error;
  }
  if (gitError) {
    try {
      await checkedGit(repository, ["worktree", "remove", "--force", disposable.workspace]);
      gitError = null;
    } catch (error) {
      gitError = error;
    }
  }
  if (gitError && !await worktreeRegistered(repository, disposable.workspace)) {
    gitError = null;
  }
  if (gitError || fileError) {
    const errors = [gitError, fileError].filter(Boolean).map((error) => error.message);
    throw evalError("eval_cleanup_error", errors.join("; "));
  }
}

async function worktreeRegistered(repository, workspace) {
  const listed = await checkedGit(repository, ["worktree", "list", "--porcelain"]);
  return listed.stdout.split("\n").some((line) => line === `worktree ${workspace}`);
}

async function workspacePatchSummary(cwd) {
  const status = await checkedGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = parsePorcelainStatus(status.stdout);
  if (entries.length > MAX_CHANGED_FILES) {
    throw evalError("patch_too_large", `Patch changes more than ${MAX_CHANGED_FILES} files`);
  }
  const diff = await checkedGit(cwd, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], {
    maxOutputBytes: MAX_PATCH_BYTES,
  });
  const numstat = await checkedGit(cwd, ["diff", "--numstat", "HEAD", "--"]);
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (const line of numstat.stdout.split("\n")) {
    if (!line) continue;
    const [added, deleted] = line.split("\t", 2);
    if (added === "-" || deleted === "-") {
      binaryFiles += 1;
      continue;
    }
    additions += Number(added) || 0;
    deletions += Number(deleted) || 0;
  }
  const untracked = entries.filter((entry) => entry.code === "??");
  const untrackedHashes = [];
  for (const entry of untracked) {
    const hashed = await checkedGit(cwd, ["hash-object", "--no-filters", "--", entry.path]);
    untrackedHashes.push([entry.path, hashed.stdout.trim()]);
  }
  const patchDigest = crypto.createHash("sha256")
    .update(diff.stdout)
    .update(JSON.stringify(untrackedHashes.sort(([left], [right]) => left.localeCompare(right))))
    .digest("hex");
  return {
    status: "available",
    changed_files: entries.length,
    added_files: entries.filter((entry) => entry.code === "??" || entry.code.includes("A")).length,
    modified_files: entries.filter((entry) => entry.code !== "??" && entry.code.includes("M")).length,
    deleted_files: entries.filter((entry) => entry.code.includes("D")).length,
    renamed_files: entries.filter((entry) => /[RC]/.test(entry.code)).length,
    untracked_files: untracked.length,
    diff_additions: additions,
    diff_deletions: deletions,
    binary_files: binaryFiles,
    patch_digest: patchDigest,
  };
}

function parsePorcelainStatus(value) {
  const fields = String(value ?? "").split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== " ") {
      throw evalError("patch_projection_error", "Git returned invalid porcelain status");
    }
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (/[RC]/.test(code)) index += 1;
  }
  return entries;
}

async function checkedGit(cwd, args, options = {}) {
  const result = await runCommand("git", args, {
    cwd,
    timeoutMs: 30000,
    maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
  });
  if (result.error || result.code !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.code}`;
    throw evalError("eval_worktree_error", `Git worktree operation failed: ${detail}`);
  }
  return result;
}

function baseCaseResult(item, expected, runRef, fields) {
  return {
    case_id: item.id,
    question_digest: item.question_digest,
    answer_digest: item.answer_schema === WORKSPACE_PATCH_SCHEMA
      ? answerDigest({ kind: WORKSPACE_PATCH_SCHEMA, verifier_digest: expected.content_digest })
      : answerDigest(expected),
    agent_run_ref: runRef,
    ...fields,
  };
}

function invalidWorkspaceCase(item, expected) {
  return baseCaseResult(item, expected, null, {
    status: "invalid",
    reason: "workspace_changed",
    metrics: { telemetry_status: "not-run" },
  });
}

async function evalMetrics(runRef, snapshot, cwd, options = {}) {
  const started = Date.parse(snapshot.started_at ?? "");
  const completed = Date.parse(snapshot.completed_at ?? "");
  const metrics = {
    telemetry_status: "available",
    turns: undefined,
    tool_calls: undefined,
    observed_file_reads: undefined,
    observed_unique_files: undefined,
    observed_file_writes: undefined,
    observed_unique_written_files: undefined,
    elapsed_ms:
      Number.isFinite(started) && Number.isFinite(completed) && completed >= started
        ? completed - started
        : undefined,
    usage: snapshot.usage,
  };
  try {
    const eventsText = await readTextIfExists(path.join(runDirFor(runRef), "events.jsonl"));
    if (eventsText === null) {
      return compact({ ...metrics, telemetry_status: "missing-events" });
    }
    const events = projectLiveStream("codex", eventsText, {
      profile: "inspect",
      default_cwd: cwd,
    });
    const toolCalls = events.filter((event) => event.kind === "tool-call");
    const turnEnd = events.findLast?.((event) => event.kind === "turn-end") ??
      [...events].reverse().find((event) => event.kind === "turn-end");
    const fileReads = toolCalls.flatMap((event) =>
      Array.isArray(event.data?.resource_accesses)
        ? event.data.resource_accesses.filter(
            (access) => access?.operation === "read" && access?.resource_kind === "file",
          )
        : [],
    );
    const fileWrites = options.includeWrites
      ? toolCalls.flatMap((event) =>
          Array.isArray(event.data?.resource_accesses)
            ? event.data.resource_accesses.filter(
                (access) => access?.operation === "write" && access?.resource_kind === "file",
              )
            : [],
        )
      : [];
    return compact({
      ...metrics,
      turns: events.filter((event) => event.kind === "turn-start").length,
      tool_calls: toolCalls.length,
      observed_file_reads: fileReads.length,
      observed_unique_files: new Set(fileReads.map((access) => access.path)).size,
      observed_file_writes: options.includeWrites ? fileWrites.length : undefined,
      observed_unique_written_files: options.includeWrites
        ? new Set(fileWrites.map((access) => access.path)).size
        : undefined,
      usage: snapshot.usage ?? turnEnd?.data?.usage,
      canonical_usage: turnEnd?.data?.canonical_usage,
    });
  } catch {
    return compact({ ...metrics, telemetry_status: "projection-error" });
  }
}

function summarizeCases(cases, planned) {
  const counts = { pass: 0, fail: 0, invalid: 0, error: 0, not_run: planned - cases.length };
  for (const item of cases) {
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
  }
  return { total: planned, ...counts };
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

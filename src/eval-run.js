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
import { getAdapter } from "./adapters.js";
import {
  CODEX_AGENT_ID,
  CODEX_EVAL_MIN_VERSION,
  supportsCodexEvalVersion,
} from "./codex-adapter.js";
import { projectLiveStream } from "./agent-session-core.js";
import { readTextIfExists, runDirFor } from "./fs-store.js";
import {
  PATCH_EVAL_EXECUTION_PROFILE,
  PATCH_EVAL_SUITE_SCHEMA_VERSION,
  READONLY_EVAL_EXECUTION_PROFILE,
  SOURCE_LOCATION_GRADER_VERSION,
  WORKSPACE_PATCH_GRADER_VERSION,
  WORKSPACE_PATCH_SCHEMA,
  answerDigest,
  buildEvalPrompt,
  canonicalizeExistingSourceLocation,
  cleanWorkspaceSnapshot,
  evalError,
  gradeSourceLocation,
  loadEvalSuite,
  normalizeExpectedVerifier,
  normalizeExpectedSourceLocation,
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

export async function runEval(input, io, internal = {}) {
  const explicitModel = explicitEvalSetting(input.model, "model");
  const explicitEffort = explicitEvalSetting(input.effort, "effort");
  await cleanupExpiredEvalResults(internal.env ?? process.env);
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const suite = await loadEvalSuite(cwd, input.suite_path);
  const subject = await cleanWorkspaceSnapshot(cwd);
  const requestedProfile = suite.schema_version === PATCH_EVAL_SUITE_SCHEMA_VERSION
    ? PATCH_EVAL_EXECUTION_PROFILE
    : READONLY_EVAL_EXECUTION_PROFILE;
  const agent = await resolveEvalAgent(
    { ...input, model: explicitModel, effort: explicitEffort },
    cwd,
    internal.env ?? process.env,
    requestedProfile,
  );
  const expected = await collectAnswers(suite, cwd, agent, io);
  const afterAnswers = await cleanWorkspaceSnapshot(cwd);
  if (!sameWorkspaceSnapshot(subject, afterAnswers)) {
    throw evalError(
      "eval_workspace_changed",
      "Eval workspace changed while standard answers were being collected",
    );
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
        timeoutMs: input.timeout_ms ?? DEFAULT_CASE_TIMEOUT_MS,
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
  }

  const completedAt = new Date();
  const summary = summarizeCases(caseResults, suite.cases.length);
  const patchEval = suite.schema_version === PATCH_EVAL_SUITE_SCHEMA_VERSION;
  const executionProfile = patchEval
    ? PATCH_EVAL_EXECUTION_PROFILE
    : READONLY_EVAL_EXECUTION_PROFILE;
  const result = {
    schema_version: patchEval ? 2 : 1,
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
    isolation: {
      policy: executionProfile,
      enforcement: "codex-permission-profile",
      data_read: [
        "workspace",
        "minimal-runtime",
        "agent-runtime",
        ...(patchEval && agent.patch_runtime_detected ? ["detected-patch-runtime"] : []),
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
      ? WORKSPACE_PATCH_GRADER_VERSION
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
  const adapter = getAdapter(input.agent_id);
  const availability = await adapter.getAvailability();
  if (!availability.available) {
    throw evalError(
      "agent_unavailable",
      `${adapter.displayName} CLI is not available: ${availability.reason}`,
    );
  }
  if (!supportsCodexEvalVersion(availability.version)) {
    throw evalError(
      "unsupported_isolation",
      `Codex Eval requires codex-cli ${CODEX_EVAL_MIN_VERSION.join(".")} or newer`,
    );
  }
  const described = await adapter.listAgent({ cwd, env });
  if (described.model_discovery?.status !== "available" || described.models.length === 0) {
    throw evalError(
      "eval_model_unavailable",
      `Codex model discovery is unavailable: ${described.model_discovery?.reason ?? "empty catalog"}`,
    );
  }
  const model = described.models.find((item) => item.id === input.model);
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
  const runtime = await codexRuntimeReadPaths(
    env,
    executionProfile === PATCH_EVAL_EXECUTION_PROFILE,
  );
  return {
    agent_id: input.agent_id,
    version: availability.version,
    model: model.id,
    effort,
    runtime_read_paths: runtime.paths,
    patch_runtime_detected: runtime.patch_runtime_detected,
  };
}

function explicitEvalSetting(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw evalError("invalid_eval_request", `Eval requires an explicit ${name}`);
  }
  return value.trim();
}

async function codexRuntimeReadPaths(env, includePatchRuntime = false) {
  const codeHome = path.resolve(env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex"));
  const candidates = [
    ...String(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.resolve(entry, "codex")),
    path.join(env.HOME ?? os.homedir(), ".local", "bin", "codex"),
    path.join(codeHome, "bin", "codex"),
    path.join(codeHome, "packages", "standalone", "current", "bin", "codex"),
  ];
  const paths = new Set();
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fsConstants.X_OK);
      const lexical = path.resolve(candidate);
      const real = await fsp.realpath(candidate);
      paths.add(path.dirname(lexical));
      paths.add(path.dirname(real));
      const standaloneRoot = ancestorNamed(real, "standalone");
      if (standaloneRoot) paths.add(standaloneRoot);
    } catch {
      // Only existing executable candidates become runtime capabilities.
    }
  }
  if (paths.size === 0) {
    throw evalError("unsupported_isolation", "Codex executable path could not be resolved");
  }
  const patchRuntimePaths = includePatchRuntime ? await pythonRuntimeReadPaths(env) : [];
  for (const item of patchRuntimePaths) paths.add(item);
  return {
    paths: Array.from(paths).sort(),
    patch_runtime_detected: patchRuntimePaths.length > 0,
  };
}

async function pythonRuntimeReadPaths(env) {
  const candidates = [
    ...String(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.resolve(entry, "python3")),
    "/usr/bin/python3",
  ];
  for (const candidate of Array.from(new Set(candidates))) {
    try {
      await fsp.access(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    const result = await runCommand(candidate, [
      "-c",
      "import json,sys; print(json.dumps([sys.executable,sys.prefix,sys.base_prefix]))",
    ], {
      env,
      timeoutMs: 5000,
      maxOutputBytes: 64 * 1024,
    });
    if (result.error || result.code !== 0) continue;
    let reported;
    try {
      reported = JSON.parse(result.stdout);
    } catch {
      continue;
    }
    if (!Array.isArray(reported)) continue;
    const paths = new Set();
    const lexical = path.resolve(candidate);
    const real = await fsp.realpath(candidate);
    paths.add(path.dirname(lexical));
    paths.add(path.dirname(real));
    for (const item of reported) {
      if (typeof item !== "string" || !path.isAbsolute(item)) continue;
      const resolved = await fsp.realpath(item).catch(() => path.resolve(item));
      const stat = await fsp.stat(resolved).catch(() => null);
      if (stat?.isDirectory()) paths.add(resolved);
      if (stat?.isFile()) paths.add(path.dirname(resolved));
      const commandLineTools = ancestorNamed(resolved, "CommandLineTools");
      if (commandLineTools) paths.add(commandLineTools);
    }
    return Array.from(paths);
  }
  return [];
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

async function collectAnswers(suite, cwd, agent, io) {
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
          answers.set(
            item.id,
            await normalizeExpectedVerifier(verifierPath, cwd, agent.runtime_read_paths),
          );
        } else {
          const raw = {
            path: await io.readLine("standard path: "),
            symbol: await io.readLine("standard symbol: "),
            definition_line: Number(await io.readLine("standard definition line: ")),
          };
          answers.set(item.id, await normalizeExpectedSourceLocation(raw, cwd));
        }
        break;
      } catch (error) {
        if (error?.code !== "invalid_eval_answer") throw error;
        io.stderr(`Invalid standard answer: ${error.message}\nPlease enter this case again.\n`);
      }
    }
  }
  io.stderr("\nStandard answers accepted; starting isolated evaluation.\n");
  return answers;
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
          runtime_read_paths: agent.runtime_read_paths,
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
        execution_profile: {
          kind: PATCH_EVAL_EXECUTION_PROFILE,
          scratch_path: scratchPath,
          output_schema_path: schemaPath,
          runtime_read_paths: agent.runtime_read_paths,
        },
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
    );
    metrics.verifier = verification.metrics;
    return baseCaseResult(item, expected, accepted.run_ref, {
      status: verification.status,
      reason: verification.reason,
      metrics,
    });
  } finally {
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

async function runVerifier(expected, cwd, env, timeoutMs) {
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
    await fsp.writeFile(verifierPath, body, { mode: 0o700 });
    await fsp.chmod(verifierPath, 0o700);
    const startedAt = Date.now();
    const result = await runCommand(verifierPath, [], {
      cwd,
      env: {
        ...verifierEnvironment(env),
        AGENT_HUB_EVAL_WORKSPACE: cwd,
        TMPDIR: verifierTmp,
        TMP: verifierTmp,
        TEMP: verifierTmp,
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

function verifierEnvironment(source) {
  const allowed = [
    "BASH_ENV",
    "GH_CONFIG_DIR",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "NS",
    "NS_UNDO",
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

async function createDisposableWorktree(subject) {
  const prefix = `.agenthub-eval-${path.basename(subject.root)}-`;
  const root = await fsp.mkdtemp(path.join(path.dirname(subject.root), prefix));
  await fsp.chmod(root, 0o700).catch(() => undefined);
  const workspace = path.join(root, "workspace");
  const hooks = path.join(root, "empty-hooks");
  try {
    await fsp.mkdir(hooks, { mode: 0o700 });
    await checkedGit(subject.root, [
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

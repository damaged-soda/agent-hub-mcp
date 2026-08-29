import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  artifactList,
  atomicWriteFile,
  atomicWriteJson,
  cleanupExpiredRuns,
  combinedLogTail,
  ensureRunDir,
  expiresAt,
  getCancellerPath,
  getRunRoot,
  getRunnerPath,
  isProcessAlive,
  nowIso,
  recentEventSummary,
  readJsonIfExists,
  readState,
  readTextIfExists,
  runDirFor,
  updateStateGuarded,
  withStateLock,
  writeState,
} from "./fs-store.js";
import { allAdapters, getAdapter } from "./adapters.js";
import { validateRequestPaths } from "./security.js";
import { buildAgentEnv } from "./env.js";
import {
  DEFAULT_RUN_AGENT_WAIT_MS,
  DEFAULT_WAIT_AGENT_RUN_MS,
  MAX_WAIT_MS,
  POLL_AFTER_MS,
} from "./timing.js";
import {
  acquireSessionLease,
  completeSessionRun,
  releaseSessionRun,
} from "./session-registry.js";

const CANCEL_GRACE_MS = 10000;

export async function listAgents(input = {}) {
  await cleanupExpiredRuns();
  let cwd = process.cwd();
  if (input?.cwd !== undefined) {
    ({ cwd } = await validateRequestPaths(input.cwd));
  }
  const env = buildAgentEnv(process.env);
  const described = await Promise.all(
    allAdapters().map((adapter) => adapter.listAgent({ cwd, env })),
  );
  return {
    agents: described.filter((agent) => agent.available),
    unavailable_agents: described.filter((agent) => !agent.available),
  };
}

function publicCliSessionRef(ref) {
  if (!ref || typeof ref.native_session_id !== "string" || ref.native_session_id.trim() === "") {
    return null;
  }
  return {
    agent_id: ref.agent_id,
    native_session_id: ref.native_session_id,
  };
}

function normalizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) {
    return {};
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("metadata must be an object");
  }
  return metadata;
}

export async function dispatchToAgent(input, internal = {}) {
  await cleanupExpiredRuns();
  const idempotencyKey = optionalNonEmptyString(internal.idempotency_key, "idempotency_key");
  if (!idempotencyKey) {
    return dispatchToAgentWithRunId(input, internal, crypto.randomUUID());
  }
  const requestHash = canonicalHash({
    input,
    expected_session_generation: internal.expected_session_generation ?? null,
    session_claim_id: internal.session_claim_id ?? null,
  });
  return withIdempotencyLock(idempotencyKey, async () => {
    const indexPath = idempotencyRecordPath(idempotencyKey);
    const existing = await readJsonIfExists(indexPath);
    if (existing && existing.request_hash !== requestHash) {
      const error = new Error(`Idempotency key ${idempotencyKey} was reused with a different request`);
      error.code = "idempotency_conflict";
      throw error;
    }
    const runId = existing?.run_id ?? crypto.randomUUID();
    const existingState = await readJsonIfExists(path.join(getRunRoot(), runId, "state.json"));
    if (existingState) {
      const livenessPid = existingState.runner_pid ?? existingState.pid;
      const existingCreatedAt = Date.parse(
        existingState.created_at ?? existingState.updated_at ?? "",
      );
      const strandedBeforeSpawn =
        ACTIVE_STATUSES.has(existingState.status) &&
        !livenessPid &&
        (!Number.isFinite(existingCreatedAt) || Date.now() - existingCreatedAt > 15000);
      if (!strandedBeforeSpawn) {
        return acceptedFromState(existingState);
      }
      await releaseSessionRun(existingState.cli_session_ref, runId).catch(() => undefined);
      await fsp.rm(path.join(getRunRoot(), runId), { recursive: true, force: true });
    }
    if (!existing) {
      await atomicWriteJson(indexPath, {
        schema_version: 1,
        idempotency_key_hash: crypto.createHash("sha256").update(idempotencyKey).digest("hex"),
        request_hash: requestHash,
        run_id: runId,
        created_at: nowIso(),
      });
    } else {
      await fsp.rm(path.join(getRunRoot(), runId), { recursive: true, force: true });
    }
    return dispatchToAgentWithRunId(input, internal, runId);
  });
}

async function dispatchToAgentWithRunId(input, internal, runId) {
  const adapter = getAdapter(input?.agent_id);
  const availability = await adapter.getAvailability();
  if (!availability.available) {
    throw new Error(`${adapter.displayName} CLI is not available: ${availability.reason}`);
  }

  if (typeof input.prompt !== "string") {
    throw new Error("prompt must be a string");
  }
  if (
    input.cli_session_ref?.agent_id &&
    input.cli_session_ref.agent_id !== adapter.agentId
  ) {
    throw new Error(
      `cli_session_ref.agent_id ${input.cli_session_ref.agent_id} does not match agent_id ${adapter.agentId}`,
    );
  }
  const metadata = normalizeMetadata(input.metadata);
  const paths = await validateRequestPaths(input.cwd, metadata, {
    metadataKey: adapter.metadataKey,
  });
  const resolvedMetadata = {
    ...metadata,
    [adapter.metadataKey]: {
      ...(metadata[adapter.metadataKey] ?? {}),
      add_dirs: paths.addDirs,
    },
  };
  const effectiveCliSessionRef = adapter.createSessionRef(input.cli_session_ref);
  let sessionRecord = null;
  if (effectiveCliSessionRef?.native_session_id) {
    sessionRecord = await acquireSessionLease(effectiveCliSessionRef, {
      run_id: runId,
      expected_generation: internal.expected_session_generation,
      claim_id: internal.session_claim_id,
    });
  }
  let runDir;
  try {
    runDir = await ensureRunDir(runId);
  } catch (error) {
    await releaseSessionRun(effectiveCliSessionRef, runId).catch(() => undefined);
    throw error;
  }
  const createdAt = nowIso();
  const internalRetention = normalizeInternalRetention(internal);

  const state = {
    schema_version: 1,
    run_id: runId,
    agent_id: input.agent_id,
    status: "queued",
    cwd: paths.cwd,
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: expiresAt(new Date(createdAt)),
    cli_session_ref: publicCliSessionRef(effectiveCliSessionRef),
    session_generation: sessionRecord?.generation,
    idempotency_key_hash: internal.idempotency_key
      ? crypto.createHash("sha256").update(internal.idempotency_key).digest("hex")
      : undefined,
    retain_until: internalRetention?.retainUntil,
    retained_by_discussion: internalRetention ? [internalRetention.discussionId] : undefined,
  };
  try {
    await writeState(runDir, state);

    await atomicWriteJson(path.join(runDir, "request.json"), {
      schema_version: 1,
      agent_id: input.agent_id,
      cwd: paths.cwd,
      prompt: input.prompt,
      metadata,
      resolved_metadata: resolvedMetadata,
      cli_session_ref: input.cli_session_ref ?? null,
      effective_cli_session_ref: effectiveCliSessionRef,
      session_generation: sessionRecord?.generation,
      created_at: createdAt,
    });
    await atomicWriteFile(path.join(runDir, "input.txt"), input.prompt);
  } catch (error) {
    await releaseSessionRun(effectiveCliSessionRef, runId).catch(() => undefined);
    throw error;
  }

  const runnerLog = await fsp.open(path.join(runDir, "runner.log"), "a", 0o600);
  let runner;
  try {
    runner = spawn(process.execPath, [getRunnerPath(), runDir], {
      cwd: paths.cwd,
      detached: true,
      env: buildRunnerEnv(process.env),
      stdio: ["ignore", "ignore", runnerLog.fd],
    });
  } finally {
    await runnerLog.close();
  }
  if (Number.isInteger(runner.pid) && runner.pid > 0) {
    await updateStateGuarded(
      runDir,
      {
        runner_pid: runner.pid,
        runner_pgid: runner.pid,
      },
      { ifStatus: "queued" },
    );
  }
  runner.once("error", (error) => {
    updateStateGuarded(
      runDir,
      {
        status: "failed",
        error: {
          code: "runner_spawn_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        completed_at: nowIso(),
        expires_at: expiresAt(),
      },
      { ifStatus: Array.from(ACTIVE_STATUSES) },
    ).catch((innerError) => {
      process.stderr.write(`${JSON.stringify({
        schema_version: 1,
        timestamp: nowIso(),
        event: "runner_spawn_failed_state_update_failed",
        error: {
          code: innerError?.code ?? "run_state_update_failed",
          message: boundedDiagnosticMessage(innerError),
        },
      })}\n`);
    });
    releaseSessionRun(effectiveCliSessionRef, runId).catch(() => undefined);
  });
  runner.unref();

  return {
    status: "accepted",
    run_ref: { run_id: runId },
    cli_session_ref: publicCliSessionRef(effectiveCliSessionRef),
    session_generation: sessionRecord?.generation,
    poll_after_ms: POLL_AFTER_MS,
  };
}

function boundedDiagnosticMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  const normalized = value.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 4096 ? `${normalized.slice(0, 4095)}…` : normalized;
}

function normalizeInternalRetention(internal) {
  if (internal.retain_until === undefined && internal.retained_by_discussion === undefined) {
    return null;
  }
  const timestamp = Date.parse(internal.retain_until ?? "");
  if (
    !Number.isFinite(timestamp) ||
    typeof internal.retained_by_discussion !== "string" ||
    !internal.retained_by_discussion
  ) {
    throw new Error("Internal run retention requires a valid date and discussion id");
  }
  return {
    retainUntil: new Date(timestamp).toISOString(),
    discussionId: internal.retained_by_discussion,
  };
}

function buildRunnerEnv(source) {
  const env = buildAgentEnv(source);
  for (const key of ["AGENT_HUB_RUN_DIR"]) {
    if (typeof source[key] === "string") env[key] = source[key];
  }
  return env;
}

async function markUnknown(runDir, runId, error) {
  const message = error instanceof Error ? error.message : String(error);
  const state = {
    schema_version: 1,
    run_id: runId,
    status: "unknown",
    error: {
      code: "state_unreadable",
      message,
    },
    updated_at: nowIso(),
    expires_at: expiresAt(),
  };
  await writeState(runDir, state);
  return state;
}

async function markMissingProcess(runDir, state) {
  const failed = await withStateLock(runDir, async () => {
    const current = await readState(runDir);
    if (!ACTIVE_STATUSES.has(current.status)) {
      return current;
    }
    const livenessPid = current.runner_pid ?? current.pid;
    if (livenessPid && isProcessAlive(livenessPid)) {
      return current;
    }
    const failed = {
      ...current,
      status: "failed",
      error: {
        code: "process_missing",
        message: "Run process is no longer alive before a terminal state was recorded",
      },
      completed_at: nowIso(),
      expires_at: expiresAt(),
    };
    await writeState(runDir, failed);
    return failed;
  });
  if (failed.status === "failed") {
    await completeSessionRun(failed.cli_session_ref, failed.run_id).catch(() => undefined);
  }
  return failed;
}

async function stateForQuery(runRef, options = {}) {
  if (options.cleanup !== false) {
    await cleanupExpiredRuns();
  }
  const runId = runRef?.run_id;
  const runDir = runDirFor(runId);
  let state;
  try {
    state = await readState(runDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Unknown run_id: ${runId}`);
    }
    state = await markUnknown(runDir, runId, error);
  }

  const livenessPid = state.runner_pid ?? state.pid;
  if (ACTIVE_STATUSES.has(state.status) && livenessPid && !isProcessAlive(livenessPid)) {
    state = await markMissingProcess(runDir, state);
  } else if (ACTIVE_STATUSES.has(state.status) && !livenessPid && isPastStartupGrace(state)) {
    state = await markMissingProcess(runDir, state);
  }
  return { runDir, state };
}

export async function queryAgentRun(input) {
  const { runDir, state } = await stateForQuery(input?.run_ref);
  return snapshotFromState(runDir, state);
}

export async function queryAgentRunSnapshot(input) {
  const { runDir, state } = await stateForQuery(input?.run_ref, { cleanup: false });
  return snapshotFromState(runDir, state);
}

export async function waitAgentRun(input) {
  await cleanupExpiredRuns();
  const timeoutMs = Math.min(input?.timeout_ms ?? DEFAULT_WAIT_AGENT_RUN_MS, MAX_WAIT_MS);
  const pollIntervalMs = input?.poll_interval_ms ?? POLL_AFTER_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeout_ms must be a positive number");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("poll_interval_ms must be a positive number");
  }

  const deadline = Date.now() + timeoutMs;
  let snapshot = await queryAgentRunNoCleanup(input);
  while (!FINAL_STATUSES.has(snapshot.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = await queryAgentRunNoCleanup(input);
  }
  if (!FINAL_STATUSES.has(snapshot.status)) {
    return {
      ...snapshot,
      timed_out: true,
      poll_after_ms: POLL_AFTER_MS,
    };
  }
  return snapshot;
}

export async function cancelAgentRun(input) {
  const { runDir, state } = await stateForQuery(input?.run_ref);
  if (FINAL_STATUSES.has(state.status)) {
    return snapshotFromState(runDir, state);
  }
  const cancelReason = optionalNonEmptyString(input?.reason, "reason");
  const cancelActor = optionalNonEmptyString(input?.actor, "actor") ?? "caller";
  const cancelledAt = nowIso();
  const cancellationState = await updateStateGuarded(
    runDir,
    {
      status: "cancelled",
      cancel_requested_at: cancelledAt,
      cancel_reason: cancelReason,
      cancel_actor: cancelActor,
      completed_at: cancelledAt,
      expires_at: expiresAt(),
    },
    { ifStatus: Array.from(ACTIVE_STATUSES) },
  );
  const latestState = await readState(runDir).catch(() => cancellationState);
  const pgid =
    latestState.pgid ??
    cancellationState.pgid ??
    state.pgid ??
    latestState.runner_pgid ??
    cancellationState.runner_pgid ??
    state.runner_pgid;
  if (Number.isInteger(pgid) && pgid > 0) {
    startCanceller(pgid);
  }
  const cancelled = await updateStateGuarded(
    runDir,
    {
      status: "cancelled",
      cancel_reason: cancelReason,
      cancel_actor: cancelActor,
      completed_at: nowIso(),
      expires_at: expiresAt(),
    },
    { ifStatus: "cancelled" },
  );
  await completeSessionRun(cancelled.cli_session_ref, cancelled.run_id).catch(() => undefined);
  return snapshotFromState(runDir, cancelled);
}

export async function runAgent(input) {
  const startedAt = Date.now();
  const timeoutMs = input?.timeout_ms ?? DEFAULT_RUN_AGENT_WAIT_MS;
  const accepted = await dispatchToAgent(input);
  const remainingTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  return waitAgentRun({
    run_ref: accepted.run_ref,
    timeout_ms: remainingTimeoutMs,
    poll_interval_ms: input?.poll_interval_ms ?? POLL_AFTER_MS,
  });
}

export async function retainAgentRun(runRef, discussionId, retainUntil) {
  const runId = runRef?.run_id;
  const runDir = runDirFor(runId);
  const timestamp = Date.parse(retainUntil);
  if (typeof discussionId !== "string" || !discussionId || !Number.isFinite(timestamp)) {
    throw new Error("discussionId and a valid retainUntil are required");
  }
  return withStateLock(runDir, async () => {
    const state = await readState(runDir);
    const retainedBy = new Set(state.retained_by_discussion ?? []);
    retainedBy.add(discussionId);
    const currentRetain = Date.parse(state.retain_until ?? "");
    const next = {
      ...state,
      retained_by_discussion: Array.from(retainedBy).sort(),
      retain_until:
        Number.isFinite(currentRetain) && currentRetain > timestamp
          ? state.retain_until
          : new Date(timestamp).toISOString(),
      updated_at: nowIso(),
    };
    await writeState(runDir, next);
    return next;
  });
}

async function queryAgentRunNoCleanup(input) {
  const { runDir, state } = await stateForQuery(input?.run_ref, { cleanup: false });
  return snapshotFromState(runDir, state);
}

export async function snapshotFromState(runDir, state) {
  const runRef = { run_id: state.run_id };
  const cliSessionRef = publicCliSessionRef(state.cli_session_ref);
  const artifacts = await artifactList(runDir);
  if (state.status === "completed") {
    const text = (await readTextIfExists(path.join(runDir, "result.txt"))) ?? "";
    return {
      status: state.status,
      content: [{ type: "text", text }],
      run_ref: runRef,
      cli_session_ref: cliSessionRef,
      session_generation: state.session_generation,
      created_at: state.created_at,
      started_at: state.started_at,
      completed_at: state.completed_at,
      usage: state.usage,
      artifacts,
    };
  }

  if (FINAL_STATUSES.has(state.status)) {
    const result = await readTextIfExists(path.join(runDir, "result.txt"));
    const tail = await combinedLogTail(runDir);
    const text = (result ?? state.error?.message ?? tail) || terminalStatusText(state.status);
    return {
      status: state.status,
      content: text ? [{ type: "text", text }] : [],
      run_ref: runRef,
      cli_session_ref: cliSessionRef,
      session_generation: state.session_generation,
      created_at: state.created_at,
      started_at: state.started_at,
      completed_at: state.completed_at,
      retryable: state.retryable ?? state.error?.retryable,
      error: state.error,
      cancel_reason: state.cancel_reason,
      cancel_actor: state.cancel_actor,
      cancel_requested_at: state.cancel_requested_at,
      artifacts,
    };
  }

  const tail = await combinedLogTail(runDir);
  const recentEvents = await recentEventSummary(runDir);
  return {
    status: state.status,
    content: [{ type: "text", text: activeStatusText(state.status) }],
    run_ref: runRef,
    cli_session_ref: cliSessionRef,
    session_generation: state.session_generation,
    created_at: state.created_at,
    started_at: state.started_at,
    log_tail: tail ? { type: "text", text: tail } : undefined,
    progress_events: recentEvents.length > 0 ? recentEvents : undefined,
    poll_after_ms: POLL_AFTER_MS,
    artifacts,
  };
}

function terminalStatusText(status) {
  if (status === "cancelled") {
    return "Run cancelled.";
  }
  if (status === "unknown") {
    return "Run state is unknown.";
  }
  return "";
}

function activeStatusText(status) {
  if (status === "queued") {
    return "Run is queued. Keep the run_ref and poll again.";
  }
  if (status === "starting") {
    return "Run is starting. Keep the run_ref and poll again.";
  }
  return "Run is still running. Keep the run_ref and poll again; do not cancel unless the user wants to stop it.";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optionalNonEmptyString(value, key) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function acceptedFromState(state) {
  return {
    status: "accepted",
    run_ref: { run_id: state.run_id },
    cli_session_ref: publicCliSessionRef(state.cli_session_ref),
    session_generation: state.session_generation,
    poll_after_ms: POLL_AFTER_MS,
  };
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function idempotencyRecordPath(key) {
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(getRunRoot(), ".internal", "idempotency", `${hash}.json`);
}

async function withIdempotencyLock(key, fn) {
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const root = path.join(getRunRoot(), ".internal", "idempotency");
  const lockDir = path.join(root, `${hash}.lock`);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700).catch(() => undefined);
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await fsp.mkdir(lockDir, { mode: 0o700 });
      await atomicWriteJson(path.join(lockDir, "owner.json"), {
        pid: process.pid,
        created_at: nowIso(),
      });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const owner = await readJsonIfExists(path.join(lockDir, "owner.json")).catch(() => null);
      const createdAt = Date.parse(owner?.created_at ?? "");
      if (Number.isFinite(createdAt) && Date.now() - createdAt > 20000) {
        await fsp.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out acquiring idempotency lock");
      }
      await sleep(10);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true });
  }
}

function signalProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function startCanceller(pgid) {
  try {
    const canceller = spawn(
      process.execPath,
      [getCancellerPath(), String(pgid), String(CANCEL_GRACE_MS)],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    canceller.unref();
  } catch {
    signalProcessGroup(pgid, "SIGTERM");
  }
}

function isPastStartupGrace(state) {
  const createdAt = Date.parse(state.created_at ?? state.updated_at ?? "");
  if (!Number.isFinite(createdAt)) {
    return true;
  }
  return Date.now() - createdAt > 5000;
}

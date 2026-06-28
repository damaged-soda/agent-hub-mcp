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
  getRunnerPath,
  isProcessAlive,
  nowIso,
  readState,
  readTextIfExists,
  runDirFor,
  updateStateGuarded,
  withStateLock,
  writeState,
} from "./fs-store.js";
import {
  CLAUDE_AGENT_ID,
  createClaudeSessionRef,
  getClaudeAvailability,
  listClaudeAgent,
} from "./claude-adapter.js";
import { validateRequestPaths } from "./security.js";
import { buildAgentEnv } from "./env.js";

const POLL_AFTER_MS = 1000;
const MAX_WAIT_MS = 3600000;
const DEFAULT_WAIT_MS = 600000;
const CANCEL_GRACE_MS = 10000;

export async function listAgents() {
  await cleanupExpiredRuns();
  const claude = await listClaudeAgent();
  return {
    agents: claude.available ? [claude] : [],
    unavailable_agents: claude.available ? [] : [claude],
  };
}

function publicCliSessionRef(ref) {
  if (!ref) {
    return null;
  }
  return {
    agent_id: ref.agent_id,
    native_session_id: ref.native_session_id,
  };
}

function assertAgent(agentId) {
  if (agentId !== CLAUDE_AGENT_ID) {
    throw new Error(`Unsupported agent_id: ${agentId}`);
  }
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

export async function dispatchToAgent(input) {
  await cleanupExpiredRuns();
  assertAgent(input?.agent_id);
  const availability = await getClaudeAvailability();
  if (!availability.available) {
    throw new Error(`Claude Code CLI is not available: ${availability.reason}`);
  }

  if (typeof input.prompt !== "string") {
    throw new Error("prompt must be a string");
  }
  const metadata = normalizeMetadata(input.metadata);
  const paths = await validateRequestPaths(input.cwd, metadata);
  const resolvedMetadata = {
    ...metadata,
    claude: {
      ...(metadata.claude ?? {}),
      add_dirs: paths.addDirs,
    },
  };
  const effectiveCliSessionRef = createClaudeSessionRef(input.cli_session_ref);
  const runId = crypto.randomUUID();
  const runDir = await ensureRunDir(runId);
  const createdAt = nowIso();

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
  };
  await writeState(runDir, state);

  await atomicWriteJson(path.join(runDir, "request.json"), {
    schema_version: 1,
    agent_id: input.agent_id,
    cwd: paths.cwd,
    metadata,
    resolved_metadata: resolvedMetadata,
    cli_session_ref: input.cli_session_ref ?? null,
    effective_cli_session_ref: effectiveCliSessionRef,
    created_at: createdAt,
  });
  await atomicWriteFile(path.join(runDir, "input.txt"), input.prompt);

  const runnerLog = await fsp.open(path.join(runDir, "runner.log"), "a", 0o600);
  let runner;
  try {
    runner = spawn(process.execPath, [getRunnerPath(), runDir], {
      cwd: paths.cwd,
      detached: true,
      env: buildAgentEnv(process.env),
      stdio: ["ignore", "ignore", runnerLog.fd],
    });
  } finally {
    await runnerLog.close();
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
      process.stderr.write(
        `runner_spawn_failed state update failed: ${
          innerError instanceof Error ? innerError.stack || innerError.message : String(innerError)
        }\n`,
      );
    });
  });
  runner.unref();

  return {
    status: "accepted",
    run_ref: { run_id: runId },
    cli_session_ref: publicCliSessionRef(effectiveCliSessionRef),
    poll_after_ms: POLL_AFTER_MS,
  };
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
  return withStateLock(runDir, async () => {
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

export async function waitAgentRun(input) {
  await cleanupExpiredRuns();
  const timeoutMs = Math.min(input?.timeout_ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
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
  const cancelledAt = nowIso();
  const cancellationState = await updateStateGuarded(
    runDir,
    {
      status: "cancelled",
      cancel_requested_at: cancelledAt,
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
      completed_at: nowIso(),
      expires_at: expiresAt(),
    },
    { ifStatus: "cancelled" },
  );
  return snapshotFromState(runDir, cancelled);
}

export async function runAgent(input) {
  const startedAt = Date.now();
  const timeoutMs = input?.timeout_ms ?? DEFAULT_WAIT_MS;
  const accepted = await dispatchToAgent(input);
  const remainingTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  return waitAgentRun({
    run_ref: accepted.run_ref,
    timeout_ms: remainingTimeoutMs,
    poll_interval_ms: input?.poll_interval_ms ?? POLL_AFTER_MS,
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
      error: state.error,
      artifacts,
    };
  }

  const tail = await combinedLogTail(runDir);
  return {
    status: state.status,
    run_ref: runRef,
    cli_session_ref: cliSessionRef,
    log_tail: tail ? { type: "text", text: tail } : undefined,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

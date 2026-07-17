import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  FINAL_STATUSES,
  atomicWriteJson,
  getRunRoot,
  nowIso,
  readJsonIfExists,
} from "./fs-store.js";

const LOCK_WAIT_MS = 5000;
const STALE_LOCK_MS = 20000;
const STALE_ACTIVE_MS = 20000;

function assertSessionRef(ref) {
  if (
    !ref ||
    typeof ref.agent_id !== "string" ||
    !ref.agent_id ||
    typeof ref.native_session_id !== "string" ||
    !ref.native_session_id
  ) {
    throw codedError("invalid_session_ref", "A complete cli_session_ref is required");
  }
}

function registryRoot() {
  return path.join(getRunRoot(), ".internal", "sessions");
}

function sessionKey(ref) {
  assertSessionRef(ref);
  return crypto
    .createHash("sha256")
    .update(`${ref.agent_id}\0${ref.native_session_id}`)
    .digest("hex");
}

function recordPath(ref) {
  return path.join(registryRoot(), `${sessionKey(ref)}.json`);
}

function lockPath(ref) {
  return path.join(registryRoot(), `${sessionKey(ref)}.lock`);
}

async function ensureRoot() {
  const root = registryRoot();
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700).catch(() => undefined);
  return root;
}

async function withSessionLock(ref, fn) {
  await ensureRoot();
  const lockDir = lockPath(ref);
  const deadline = Date.now() + LOCK_WAIT_MS;
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
      if (Number.isFinite(createdAt) && Date.now() - createdAt > STALE_LOCK_MS) {
        await fsp.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw codedError("session_lock_timeout", "Timed out acquiring session registry lock");
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

async function readRecord(ref) {
  return readJsonIfExists(recordPath(ref));
}

function initialRecord(ref) {
  return {
    schema_version: 1,
    agent_id: ref.agent_id,
    native_session_id: ref.native_session_id,
    generation: 0,
    latest_run_id: null,
    active_run_id: null,
    reserved_by: null,
    updated_at: nowIso(),
  };
}

async function clearStaleActive(record) {
  if (!record?.active_run_id) {
    return record;
  }
  const runState = await readJsonIfExists(
    path.join(getRunRoot(), record.active_run_id, "state.json"),
  ).catch(() => null);
  if (runState && FINAL_STATUSES.has(runState.status)) {
    return { ...record, active_run_id: null, active_since: null };
  }
  const activeSince = Date.parse(record.active_since ?? "");
  if (!runState && Number.isFinite(activeSince) && Date.now() - activeSince > STALE_ACTIVE_MS) {
    return { ...record, active_run_id: null, active_since: null };
  }
  return record;
}

export async function getSessionRecord(ref) {
  assertSessionRef(ref);
  return readRecord(ref);
}

export async function claimSessionLineage(ref, options) {
  const claimId = requiredString(options?.claim_id, "claim_id");
  const expectedGeneration = requiredGeneration(options?.expected_generation);
  return withSessionLock(ref, async () => {
    let record = await clearStaleActive((await readRecord(ref)) ?? initialRecord(ref));
    if (record.active_run_id) {
      throw codedError("session_busy", `Session is active in run ${record.active_run_id}`);
    }
    if (record.reserved_by === claimId) {
      return record;
    }
    if (record.generation !== expectedGeneration) {
      throw codedError(
        "session_generation_conflict",
        `Expected session generation ${expectedGeneration}, found ${record.generation}`,
      );
    }
    if (record.reserved_by && record.reserved_by !== claimId) {
      throw codedError("session_reserved", `Session is reserved by ${record.reserved_by}`);
    }
    record = {
      ...record,
      generation: record.generation + 1,
      reserved_by: claimId,
      reserved_at: nowIso(),
      updated_at: nowIso(),
    };
    await atomicWriteJson(recordPath(ref), record);
    return record;
  });
}

export async function acquireSessionLease(ref, options) {
  const runId = requiredString(options?.run_id, "run_id");
  const claimId = optionalString(options?.claim_id);
  const expectedGeneration = optionalGeneration(options?.expected_generation);
  return withSessionLock(ref, async () => {
    let record = await clearStaleActive((await readRecord(ref)) ?? initialRecord(ref));
    if (record.active_run_id === runId) {
      return record;
    }
    if (record.active_run_id) {
      throw codedError("session_busy", `Session is active in run ${record.active_run_id}`);
    }
    if (record.reserved_by && record.reserved_by !== claimId) {
      throw codedError("session_reserved", `Session is reserved by ${record.reserved_by}`);
    }
    if (expectedGeneration !== undefined && record.generation !== expectedGeneration) {
      throw codedError(
        "session_generation_conflict",
        `Expected session generation ${expectedGeneration}, found ${record.generation}`,
      );
    }
    record = {
      ...record,
      generation: record.generation + 1,
      active_run_id: runId,
      active_since: nowIso(),
      reserved_by: null,
      reserved_at: null,
      updated_at: nowIso(),
    };
    await atomicWriteJson(recordPath(ref), record);
    return record;
  });
}

export async function completeSessionRun(ref, runId) {
  if (!ref?.native_session_id) {
    return null;
  }
  return withSessionLock(ref, async () => {
    let record = (await readRecord(ref)) ?? initialRecord(ref);
    record = {
      ...record,
      active_run_id: record.active_run_id === runId ? null : record.active_run_id,
      active_since: record.active_run_id === runId ? null : record.active_since,
      latest_run_id: runId,
      updated_at: nowIso(),
    };
    await atomicWriteJson(recordPath(ref), record);
    return record;
  });
}

export async function releaseSessionRun(ref, runId) {
  if (!ref?.native_session_id) {
    return null;
  }
  return withSessionLock(ref, async () => {
    const record = await readRecord(ref);
    if (!record || record.active_run_id !== runId) {
      return record;
    }
    const next = {
      ...record,
      active_run_id: null,
      active_since: null,
      updated_at: nowIso(),
    };
    await atomicWriteJson(recordPath(ref), next);
    return next;
  });
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) {
    throw codedError("invalid_session_option", `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredString(value, "claim_id");
}

function requiredGeneration(value) {
  const generation = optionalGeneration(value);
  if (generation === undefined) {
    throw codedError("invalid_session_option", "expected_generation is required");
  }
  return generation;
}

function optionalGeneration(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw codedError("invalid_session_option", "expected_generation must be a non-negative integer");
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

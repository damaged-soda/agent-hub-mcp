import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteFile,
  atomicWriteJson,
  getRunRoot,
  nowIso,
  readJsonIfExists,
  readTextIfExists,
} from "./fs-store.js";

export const DISCUSSION_FINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
const DEFAULT_DISCUSSION_TTL_SECONDS = 604800;
const LEASE_HEARTBEAT_MS = 5000;
const LEASE_STALE_MS = 20000;

export function discussionTtlSeconds() {
  const raw =
    process.env.AGENT_HUB_DISCUSSION_TTL_SECONDS ?? process.env.AGENT_HUB_RUN_TTL_SECONDS;
  if (raw === undefined || raw === "") {
    return DEFAULT_DISCUSSION_TTL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("AGENT_HUB_DISCUSSION_TTL_SECONDS must be a non-negative number");
  }
  return parsed;
}

export function discussionExpiresAt(from = new Date()) {
  return new Date(from.getTime() + discussionTtlSeconds() * 1000).toISOString();
}

export function getDiscussionRoot() {
  if (process.env.AGENT_HUB_DISCUSSION_DIR) {
    return path.resolve(process.env.AGENT_HUB_DISCUSSION_DIR);
  }
  return path.join(path.dirname(getRunRoot()), "discussions");
}

export function assertDiscussionId(id) {
  if (typeof id !== "string" || id.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error("Invalid discussion_id");
  }
}

export function discussionDirFor(id) {
  assertDiscussionId(id);
  return path.join(getDiscussionRoot(), id);
}

export async function ensureDiscussionRoot() {
  const root = getDiscussionRoot();
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700).catch(() => undefined);
  return root;
}

export async function createDiscussionRecord(initialState, request) {
  const id = initialState.discussion_id;
  const root = await ensureDiscussionRoot();
  const dir = path.join(root, id);
  await fsp.mkdir(dir, { mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => undefined);
  await atomicWriteJson(path.join(dir, "request.json"), request);
  await atomicWriteFile(path.join(dir, "events.jsonl"), "");
  await atomicWriteJson(path.join(dir, "state.json"), {
    ...initialState,
    committed_event_sequence: 0,
    updated_at: initialState.updated_at ?? nowIso(),
  });
  await appendDiscussionEvent(
    id,
    "discussion.created",
    { kind: request.kind, parent_discussion_ref: request.parent_discussion_ref ?? null },
    (state) => state,
    { skip_lease: true },
  );
  return readDiscussionState(id);
}

export async function removeDiscussionRecord(id) {
  await fsp.rm(discussionDirFor(id), { recursive: true, force: true });
}

export async function readDiscussionState(id) {
  const state = await readJsonIfExists(path.join(discussionDirFor(id), "state.json"));
  if (!state) {
    throw unknownDiscussion(id);
  }
  return state;
}

export async function readDiscussionRequest(id) {
  const request = await readJsonIfExists(path.join(discussionDirFor(id), "request.json"));
  if (!request) {
    throw unknownDiscussion(id);
  }
  return request;
}

export async function appendDiscussionEvent(id, type, payload, mutateState, options = {}) {
  return withDiscussionLock(id, async () => {
    const dir = discussionDirFor(id);
    const current = await readJsonIfExists(path.join(dir, "state.json"));
    if (!current) {
      throw unknownDiscussion(id);
    }
    if (!options.skip_lease) {
      await assertDiscussionLease(id, options.lease);
    }
    const sequence = (current.committed_event_sequence ?? 0) + 1;
    const timestamp = nowIso();
    const mutated = mutateState ? await mutateState(structuredClone(current)) : current;
    const next = {
      ...mutated,
      committed_event_sequence: sequence,
      updated_at: timestamp,
    };
    const event = {
      schema_version: 1,
      sequence,
      author: options.author ?? payload?.member_id ?? "coordinator",
      type,
      timestamp,
      payload: payload ?? {},
      projection: next,
    };
    await appendAndSync(path.join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    await atomicWriteJson(path.join(dir, "state.json"), next);
    return { event, state: next };
  });
}

export async function readDiscussionEvents(id, options = {}) {
  const eventPath = path.join(discussionDirFor(id), "events.jsonl");
  const text = (await readTextIfExists(eventPath)) ?? "";
  const lines = text.split("\n");
  const events = [];
  let consumedBytes = 0;
  let repairedBytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
    if (!line) {
      consumedBytes += lineBytes;
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      const isTail = index === lines.length - 1 || lines.slice(index + 1).every((item) => !item);
      if (!options.repair_tail || !isTail) {
        throw codedError("discussion_events_corrupt", `Invalid event at line ${index + 1}`);
      }
      repairedBytes = Buffer.byteLength(text, "utf8") - consumedBytes;
      await fsp.truncate(eventPath, consumedBytes);
      break;
    }
    const expected = events.length + 1;
    if (event.sequence !== expected) {
      throw codedError(
        "discussion_events_corrupt",
        `Expected event sequence ${expected}, found ${event.sequence}`,
      );
    }
    events.push(event);
    consumedBytes += lineBytes;
  }
  return { events, repaired_bytes: repairedBytes };
}

export async function recoverDiscussionRecord(id) {
  const { projected, repairedBytes } = await withDiscussionLock(id, async () => {
    const { events, repaired_bytes: repairedBytes } = await readDiscussionEvents(id, {
      repair_tail: true,
    });
    if (events.length === 0) {
      throw codedError("discussion_events_corrupt", "Discussion has no committed events");
    }
    const projected = events.at(-1).projection;
    if (!projected || typeof projected !== "object") {
      throw codedError("discussion_events_corrupt", "Last event has no state projection");
    }
    const current = await readJsonIfExists(path.join(discussionDirFor(id), "state.json")).catch(
      () => null,
    );
    if (!current || JSON.stringify(current) !== JSON.stringify(projected)) {
      await atomicWriteJson(path.join(discussionDirFor(id), "state.json"), projected);
    }
    return { projected, repairedBytes };
  });
  if (repairedBytes > 0) {
    return appendDiscussionEvent(
      id,
      "discussion.recovered",
      { discarded_tail_bytes: repairedBytes, reason: "partial_tail" },
      (state) => state,
      { skip_lease: true },
    ).then((result) => result.state);
  }
  return projected;
}

export async function markDiscussionUnknown(id, error) {
  const dir = discussionDirFor(id);
  const current = await readJsonIfExists(path.join(dir, "state.json")).catch(() => null);
  const detectedAt = nowIso();
  const unknown = {
    ...(current ?? { schema_version: 1, discussion_id: id }),
    status: "unknown",
    error: { code: error?.code ?? "discussion_state_unknown", message: String(error?.message ?? error) },
    completed_at: detectedAt,
    expires_at: discussionExpiresAt(new Date(detectedAt)),
    updated_at: detectedAt,
  };
  await atomicWriteJson(path.join(dir, "state.json"), unknown);
  return unknown;
}

export async function acquireDiscussionLease(id, ownerId) {
  return withDiscussionLock(id, async () => {
    const leasePath = path.join(discussionDirFor(id), "lease.json");
    const current = await readJsonIfExists(leasePath);
    const now = Date.now();
    if (current?.owner_id === ownerId) {
      const renewed = { ...current, heartbeat_at: new Date(now).toISOString() };
      await atomicWriteJson(leasePath, renewed);
      return renewed;
    }
    const heartbeat = Date.parse(current?.heartbeat_at ?? "");
    if (
      current &&
      Number.isFinite(heartbeat) &&
      now - heartbeat < LEASE_STALE_MS &&
      leaseOwnerProcessIsLive(current)
    ) {
      throw codedError("discussion_lease_held", `Discussion lease is held by ${current.owner_id}`);
    }
    const lease = {
      schema_version: 1,
      owner_id: ownerId,
      pid: process.pid,
      generation: (current?.generation ?? 0) + 1,
      heartbeat_at: new Date(now).toISOString(),
    };
    await atomicWriteJson(leasePath, lease);
    return lease;
  });
}

export async function discussionLeaseIsLive(id) {
  const current = await readJsonIfExists(path.join(discussionDirFor(id), "lease.json"));
  const heartbeat = Date.parse(current?.heartbeat_at ?? "");
  return Boolean(
    current &&
      Number.isFinite(heartbeat) &&
      Date.now() - heartbeat < LEASE_STALE_MS &&
      leaseOwnerProcessIsLive(current),
  );
}

export async function heartbeatDiscussionLease(id, lease) {
  return withDiscussionLock(id, async () => {
    const leasePath = path.join(discussionDirFor(id), "lease.json");
    const current = await readJsonIfExists(leasePath);
    assertLeaseMatches(current, lease);
    const renewed = { ...current, heartbeat_at: nowIso() };
    await atomicWriteJson(leasePath, renewed);
    return renewed;
  });
}

export async function releaseDiscussionLease(id, lease) {
  return withDiscussionLock(id, async () => {
    const leasePath = path.join(discussionDirFor(id), "lease.json");
    const current = await readJsonIfExists(leasePath);
    if (current && current.owner_id === lease?.owner_id && current.generation === lease?.generation) {
      await fsp.rm(leasePath, { force: true });
      return true;
    }
    return false;
  });
}

export async function assertDiscussionLease(id, lease) {
  const current = await readJsonIfExists(path.join(discussionDirFor(id), "lease.json"));
  assertLeaseMatches(current, lease);
}

export async function listNonTerminalDiscussions() {
  const root = await ensureDiscussionRoot();
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) continue;
    const state = await readJsonIfExists(path.join(root, entry.name, "state.json")).catch(() => null);
    if (state && !DISCUSSION_FINAL_STATUSES.has(state.status)) ids.push(entry.name);
  }
  return ids;
}

export async function cleanupExpiredDiscussions() {
  const root = await ensureDiscussionRoot();
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const state = await readJsonIfExists(path.join(dir, "state.json")).catch(() => null);
    if (
      state &&
      DISCUSSION_FINAL_STATUSES.has(state.status) &&
      Number.isFinite(Date.parse(state.expires_at ?? "")) &&
      Date.parse(state.expires_at) <= now
    ) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
}

export async function discussionEventsPage(id, options = {}) {
  const { events } = await readDiscussionEvents(id);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const after = options.after_sequence;
  const selected = Number.isInteger(after)
    ? events.filter((event) => event.sequence > after).slice(0, limit)
    : events.slice(-limit);
  const nextSequence = selected.at(-1)?.sequence ?? after ?? events.at(-1)?.sequence ?? 0;
  return {
    events: selected,
    next_sequence: nextSequence,
    has_more: events.some((event) => event.sequence > nextSequence),
  };
}

export async function writeDiscussionArtifact(id, relativePath, value) {
  const target = safeArtifactPath(id, relativePath);
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    await atomicWriteFile(target, value);
  } else {
    await atomicWriteJson(target, value);
  }
  return { path: relativePath };
}

export async function readDiscussionArtifact(id, relativePath) {
  return readTextIfExists(safeArtifactPath(id, relativePath));
}

export async function discussionArtifacts(id) {
  const candidates = [
    ["request.json", "request"],
    ["events.jsonl", "events"],
    ["materials/manifest.json", "materials"],
    ["handoff/context.json", "handoff"],
    ["decision.json", "decision"],
    ["decision.md", "decision"],
  ];
  const artifacts = [];
  for (const [relativePath, type] of candidates) {
    if (await readTextIfExists(safeArtifactPath(id, relativePath))) {
      artifacts.push({ type, title: path.basename(relativePath), path: relativePath });
    }
  }
  return artifacts;
}

export async function withDiscussionLock(id, fn) {
  const dir = discussionDirFor(id);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const lockDir = path.join(dir, ".discussion.lock");
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await fsp.mkdir(lockDir, { mode: 0o700 });
      await atomicWriteJson(path.join(lockDir, "owner.json"), {
        pid: process.pid,
        nonce: crypto.randomUUID(),
        created_at: nowIso(),
      });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readJsonIfExists(path.join(lockDir, "owner.json")).catch(() => null);
      const createdAt = Date.parse(owner?.created_at ?? "");
      const lockStat = owner ? null : await fsp.stat(lockDir).catch(() => null);
      const abandonedBeforeOwnerWrite =
        !owner && lockStat && Date.now() - lockStat.mtimeMs > 1000;
      if (
        abandonedBeforeOwnerWrite ||
        (owner && !leaseOwnerProcessIsLive(owner)) ||
        (Number.isFinite(createdAt) && Date.now() - createdAt > LEASE_STALE_MS)
      ) {
        await fsp.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw codedError("discussion_lock_timeout", `Timed out locking discussion ${id}`);
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

function assertLeaseMatches(current, expected) {
  if (
    !current ||
    !expected ||
    current.owner_id !== expected.owner_id ||
    current.generation !== expected.generation
  ) {
    throw codedError("discussion_lease_lost", "Discussion controller no longer owns the lease");
  }
}

function leaseOwnerProcessIsLive(lease) {
  if (!Number.isSafeInteger(lease?.pid) || lease.pid <= 0) return true;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function appendAndSync(filePath, chunk) {
  const buffer = Buffer.from(chunk);
  const handle = await fsp.open(filePath, "a", 0o600);
  const originalSize = (await handle.stat()).size;
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesWritten <= 0) {
        throw codedError("discussion_event_write_failed", "Event append made no progress");
      }
      offset += bytesWritten;
    }
    await handle.sync();
  } catch (error) {
    await handle
      .truncate(originalSize)
      .then(() => handle.sync())
      .catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

function safeArtifactPath(id, relativePath) {
  if (
    typeof relativePath !== "string" ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error("Invalid discussion artifact path");
  }
  return path.join(discussionDirFor(id), relativePath);
}

function unknownDiscussion(id) {
  return codedError("unknown_discussion", `Unknown discussion_id: ${id}`);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DISCUSSION_LEASE_HEARTBEAT_MS = LEASE_HEARTBEAT_MS;

import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const FINAL_STATUSES = new Set(["completed", "failed", "cancelled", "unknown"]);
export const ACTIVE_STATUSES = new Set(["queued", "starting", "running"]);

const DEFAULT_TTL_SECONDS = 604800;

export function nowIso() {
  return new Date().toISOString();
}

export function ttlSeconds() {
  const raw = process.env.AGENT_HUB_RUN_TTL_SECONDS;
  if (!raw) {
    return DEFAULT_TTL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("AGENT_HUB_RUN_TTL_SECONDS must be a non-negative number");
  }
  return parsed;
}

export function expiresAt(from = new Date(), ttl = ttlSeconds()) {
  return new Date(from.getTime() + ttl * 1000).toISOString();
}

export function getRunRoot() {
  if (process.env.AGENT_HUB_RUN_DIR) {
    return path.resolve(process.env.AGENT_HUB_RUN_DIR);
  }
  const cacheHome = process.env.XDG_CACHE_HOME
    ? path.resolve(process.env.XDG_CACHE_HOME)
    : path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "agent-hub-mcp", "runs");
}

export function assertSafeRunId(runId) {
  if (
    typeof runId !== "string" ||
    runId.length > 80 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)
  ) {
    throw new Error("Invalid run_id");
  }
}

export function runDirFor(runRefOrId) {
  const runId = typeof runRefOrId === "string" ? runRefOrId : runRefOrId?.run_id;
  assertSafeRunId(runId);
  return path.join(getRunRoot(), runId);
}

export async function ensureRunRoot() {
  const root = getRunRoot();
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700).catch(() => undefined);
  return root;
}

export async function ensureRunDir(runId) {
  const root = await ensureRunRoot();
  const dir = path.join(root, runId);
  await fsp.mkdir(dir, { recursive: false, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

export async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteFile(filePath, data, mode = 0o600) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto
      .randomBytes(8)
      .toString("hex")}.tmp`,
  );
  const handle = await fsp.open(tmpPath, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmpPath, filePath);
}

export async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

export async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readState(runDir) {
  return readJson(path.join(runDir, "state.json"));
}

export async function writeState(runDir, state) {
  await atomicWriteJson(path.join(runDir, "state.json"), {
    ...state,
    updated_at: state.updated_at ?? nowIso(),
  });
}

export async function updateState(runDir, patch) {
  return updateStateGuarded(runDir, patch);
}

export async function updateStateGuarded(runDir, patch, options = {}) {
  return withStateLock(runDir, async () => {
    const current = await readJsonIfExists(path.join(runDir, "state.json"));
    if (current && options.ifStatus) {
      const allowed = Array.isArray(options.ifStatus) ? options.ifStatus : [options.ifStatus];
      if (!allowed.includes(current.status)) {
        return current;
      }
    }
    if (current && options.unlessStatus) {
      const denied = Array.isArray(options.unlessStatus)
        ? options.unlessStatus
        : [options.unlessStatus];
      if (denied.includes(current.status)) {
        return current;
      }
    }
    const next = {
      ...(current ?? {}),
      ...patch,
      updated_at: nowIso(),
    };
    await writeState(runDir, next);
    return next;
  });
}

export async function appendFile(filePath, chunk) {
  await fsp.appendFile(filePath, chunk, { mode: 0o600 });
}

export async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function tailText(filePath, maxBytes = 8192) {
  try {
    const stat = await fsp.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function cleanupExpiredRuns() {
  const root = await ensureRunRoot();
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const runDir = path.join(root, entry.name);
        const state = await readJsonIfExists(path.join(runDir, "state.json")).catch(() => null);
        if (!state || !FINAL_STATUSES.has(state.status) || !state.expires_at) {
          return;
        }
        if (Date.parse(state.expires_at) <= now) {
          await fsp.rm(runDir, { recursive: true, force: true });
        }
      }),
  );
}

export async function artifactList(runDir) {
  const names = [
    ["request.json", "request", "request"],
    ["command.json", "command", "command"],
    ["stdout.log", "log", "stdout"],
    ["stderr.log", "log", "stderr"],
    ["events.jsonl", "log", "events"],
    ["runner.log", "log", "runner"],
    ["result.json", "result", "result.json"],
    ["result.txt", "result", "result.txt"],
  ];
  const artifacts = [];
  for (const [name, type, title] of names) {
    if (await pathExists(path.join(runDir, name))) {
      artifacts.push({ type, title, path: name });
    }
  }
  return artifacts;
}

export async function combinedLogTail(runDir) {
  const stderr = await tailText(path.join(runDir, "stderr.log"));
  const pieces = [];
  if (stderr.trim()) {
    pieces.push(`[stderr]\n${stderr.trimEnd()}`);
  }
  return pieces.join("\n\n");
}

export async function recentEventSummary(runDir, maxEvents = 5) {
  const text = await tailText(path.join(runDir, "events.jsonl"), 65536);
  if (!text.trim()) {
    return [];
  }
  const summaries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const summary = summarizeClaudeEvent(event);
    if (summary) {
      summaries.push(summary);
    }
  }
  return summaries.slice(-maxEvents);
}

function summarizeClaudeEvent(event) {
  if (event?.type === "system" && event.subtype === "init") {
    return {
      type: "system",
      message: `Claude session initialized${event.model ? ` with ${event.model}` : ""}.`,
      session_id: typeof event.session_id === "string" ? event.session_id : undefined,
    };
  }
  if (event?.type === "assistant") {
    const text = collectContentText(event.message?.content);
    if (text) {
      return {
        type: "assistant",
        message: truncate(text, 1000),
        session_id: typeof event.session_id === "string" ? event.session_id : undefined,
      };
    }
    const toolNames = collectToolNames(event.message?.content);
    if (toolNames.length > 0) {
      return {
        type: "assistant",
        message: `Using tools: ${toolNames.join(", ")}.`,
        session_id: typeof event.session_id === "string" ? event.session_id : undefined,
      };
    }
  }
  if (event?.type === "result") {
    const resultText =
      typeof event.result === "string" && event.result.trim()
        ? ` ${truncate(event.result.trim(), 1000)}`
        : "";
    return {
      type: "result",
      message: `${event.is_error ? "Failed" : "Completed"}${resultText}`,
      session_id: typeof event.session_id === "string" ? event.session_id : undefined,
    };
  }
  if (event?.type === "rate_limit_event") {
    const status = event.rate_limit_info?.status;
    return {
      type: "rate_limit",
      message: status ? `Rate limit status: ${status}.` : "Rate limit event.",
      session_id: typeof event.session_id === "string" ? event.session_id : undefined,
    };
  }
  return null;
}

function collectContentText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function collectToolNames(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((block) => block?.type === "tool_use" && typeof block.name === "string")
    .map((block) => block.name);
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

export function currentEnvKeys(env = process.env) {
  const sensitiveFragments = [
    "AUTH",
    "CERT",
    "CREDENTIAL",
    "KEY",
    "PASSPHRASE",
    "PASSWORD",
    "PRIVATE",
    "SECRET",
    "TOKEN",
  ];
  return Object.keys(env)
    .filter((key) => {
      const upper = key.toUpperCase();
      return !sensitiveFragments.some((fragment) => upper.includes(fragment));
    })
    .sort();
}

export function getRunnerPath() {
  return new URL("./runner.js", import.meta.url).pathname;
}

export function getCancellerPath() {
  return new URL("./canceller.js", import.meta.url).pathname;
}

export function getServerPath() {
  return new URL("./server.js", import.meta.url).pathname;
}

export function syncAppend(filePath, chunk) {
  fs.appendFileSync(filePath, chunk, { mode: 0o600 });
}

export async function withStateLock(runDir, fn) {
  const lockDir = path.join(runDir, ".state.lock");
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await fsp.mkdir(lockDir, { mode: 0o700 });
      try {
        await atomicWriteJson(path.join(lockDir, "owner.json"), {
          pid: process.pid,
          created_at: nowIso(),
        });
      } catch (error) {
        await fsp.rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        throw error;
      }
      await removeLockIfOwnerDead(lockDir);
      await sleep(10);
    }
  }

  try {
    return await fn();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeLockIfOwnerDead(lockDir) {
  const owner = await readJsonIfExists(path.join(lockDir, "owner.json")).catch(() => null);
  if (!owner || !Number.isInteger(owner.pid)) {
    return;
  }
  const createdAt = Date.parse(owner.created_at ?? "");
  if (Number.isFinite(createdAt) && Date.now() - createdAt > 5000) {
    await fsp.rm(lockDir, { recursive: true, force: true });
    return;
  }
  if (isProcessAlive(owner.pid)) {
    return;
  }
  await fsp.rm(lockDir, { recursive: true, force: true });
}

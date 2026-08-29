import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJson,
  isProcessAlive,
  readJsonIfExists,
} from "./fs-store.js";

const CACHE_SCHEMA_VERSION = 1;
const CACHE_KIND = "agent-catalog-cache";
const DEFAULT_FRESH_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_MS = 60 * 1000;
const REFRESH_LOCK_STALE_MS = 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const REFRESH_WORKER_PATH = fileURLToPath(
  new URL("./agent-catalog-refresh-worker.js", import.meta.url),
);

// Only non-secret routing/configuration identity participates in the key. Credential values are
// deliberately excluded: status may be briefly stale after an account change, while set/dispatch
// still perform live validation.
const CACHE_IDENTITY_ENV_KEYS = Object.freeze([
  "AGENT_HUB_FORWARD_ENV",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "KIMI_CODE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

export function getAgentCatalogCacheRoot(env = process.env) {
  if (env.AGENT_HUB_CATALOG_CACHE_DIR) {
    return path.resolve(env.AGENT_HUB_CATALOG_CACHE_DIR);
  }
  const cacheHome = env.XDG_CACHE_HOME
    ? path.resolve(env.XDG_CACHE_HOME)
    : path.join(typeof env.HOME === "string" ? env.HOME : os.homedir(), ".cache");
  return path.join(cacheHome, "agent-hub-mcp", "agent-catalog");
}

export function getAgentCatalogCacheLocation(cwd, options = {}) {
  const env = options.env ?? process.env;
  const root = options.cache_root ?? getAgentCatalogCacheRoot(env);
  const identity = {
    schema_version: CACHE_SCHEMA_VERSION,
    cwd,
    env: Object.fromEntries(
      CACHE_IDENTITY_ENV_KEYS.flatMap((key) =>
        typeof env[key] === "string" ? [[key, env[key]]] : []),
    ),
  };
  const key = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const directory = path.join(root, key);
  return {
    root,
    directory,
    cache_path: path.join(directory, "catalog.json"),
    lock_path: path.join(directory, ".refresh.lock"),
  };
}

export async function loadAgentCatalogForStatus(options) {
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const freshMs = options.fresh_ms ?? DEFAULT_FRESH_MS;
  const maxStaleMs = options.max_stale_ms ?? DEFAULT_MAX_STALE_MS;
  const retryMs = options.retry_ms ?? DEFAULT_RETRY_MS;
  const location = getAgentCatalogCacheLocation(options.cwd, options);
  const record = await readCacheRecord(location.cache_path);

  if (record) {
    const ageMs = cacheAgeMs(record, nowMs);
    if (ageMs <= freshMs) {
      return {
        catalog: record.catalog,
        cache: cacheMetadata("fresh", record, ageMs, "not-needed"),
      };
    }
    if (ageMs <= maxStaleMs) {
      const failedAgeMs = timestampAgeMs(record.last_refresh_failed_at, nowMs);
      let refresh = "scheduled";
      let refreshError = null;
      if (failedAgeMs !== null && failedAgeMs < retryMs) {
        refresh = "backoff";
      } else {
        try {
          await (options.spawn_refresh ?? spawnAgentCatalogRefreshWorker)({
            cwd: options.cwd,
            env: options.env ?? process.env,
            cache_root: options.cache_root,
          });
        } catch (error) {
          refresh = "start-failed";
          refreshError = compactError(error);
        }
      }
      return {
        catalog: record.catalog,
        cache: cacheMetadata("stale", record, ageMs, refresh, refreshError),
      };
    }
  }

  const catalog = await options.load_catalog();
  const observedAt = new Date(now()).toISOString();
  let writeError = null;
  try {
    await writeCacheRecord(location, catalog, observedAt);
  } catch (error) {
    writeError = compactError(error);
  }
  return {
    catalog,
    cache: {
      status: writeError ? "uncached" : "refreshed",
      observed_at: observedAt,
      age_seconds: 0,
      refresh: "synchronous",
      ...(writeError ? { error: writeError } : {}),
    },
  };
}

export async function storeAgentCatalog(cwd, catalog, options = {}) {
  const now = options.now ?? (() => Date.now());
  const location = getAgentCatalogCacheLocation(cwd, options);
  const observedAt = new Date(now()).toISOString();
  await writeCacheRecord(location, catalog, observedAt);
  return observedAt;
}

export async function refreshAgentCatalogCache(options) {
  const now = options.now ?? (() => Date.now());
  const location = getAgentCatalogCacheLocation(options.cwd, options);
  const lock = await acquireRefreshLock(location, now());
  if (!lock) return { refreshed: false, reason: "refresh-in-progress" };

  try {
    const current = await readCacheRecord(location.cache_path);
    if (current && cacheAgeMs(current, now()) <= (options.fresh_ms ?? DEFAULT_FRESH_MS)) {
      return { refreshed: false, reason: "already-fresh" };
    }
    try {
      const catalog = await options.load_catalog();
      const observedAt = new Date(now()).toISOString();
      await writeCacheRecord(location, catalog, observedAt);
      return { refreshed: true, observed_at: observedAt };
    } catch (error) {
      if (current) {
        await atomicWriteJson(location.cache_path, {
          ...current,
          last_refresh_failed_at: new Date(now()).toISOString(),
          last_refresh_error: compactError(error),
        }).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    await releaseRefreshLock(location, lock);
  }
}

export async function spawnAgentCatalogRefreshWorker(options) {
  const args = [REFRESH_WORKER_PATH, options.cwd];
  if (options.cache_root) args.push(options.cache_root);
  const child = spawn(process.execPath, args, {
    detached: true,
    env: options.env ?? process.env,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function readCacheRecord(cachePath) {
  const value = await readJsonIfExists(cachePath).catch(() => null);
  return validCacheRecord(value) ? value : null;
}

function validCacheRecord(value) {
  return value?.schema_version === CACHE_SCHEMA_VERSION &&
    value.kind === CACHE_KIND &&
    Number.isFinite(Date.parse(value.observed_at ?? "")) &&
    validCatalog(value.catalog);
}

function validCatalog(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Array.isArray(value.agents) && Array.isArray(value.unavailable_agents) &&
    [...value.agents, ...value.unavailable_agents].every((agent) =>
      agent && typeof agent === "object" && !Array.isArray(agent) &&
      typeof agent.agent_id === "string" && agent.agent_id.length > 0 &&
      Array.isArray(agent.models) && agent.models.every((model) =>
        model && typeof model === "object" && !Array.isArray(model) &&
        typeof model.id === "string" && model.id.length > 0));
}

async function writeCacheRecord(location, catalog, observedAt) {
  if (!validCatalog(catalog)) throw new Error("agent catalog cache payload is invalid");
  await ensureCacheDirectory(location);
  await atomicWriteJson(location.cache_path, {
    schema_version: CACHE_SCHEMA_VERSION,
    kind: CACHE_KIND,
    observed_at: observedAt,
    catalog,
  });
}

function cacheAgeMs(record, nowMs) {
  const delta = nowMs - Date.parse(record.observed_at);
  return delta < -MAX_CLOCK_SKEW_MS ? Number.POSITIVE_INFINITY : Math.max(0, delta);
}

function timestampAgeMs(value, nowMs) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}

function cacheMetadata(status, record, ageMs, refresh, refreshError = null) {
  return {
    status,
    observed_at: record.observed_at,
    age_seconds: Math.floor(ageMs / 1000),
    refresh,
    ...(record.last_refresh_failed_at
      ? { last_refresh_failed_at: record.last_refresh_failed_at }
      : {}),
    ...(record.last_refresh_error ? { last_refresh_error: record.last_refresh_error } : {}),
    ...(refreshError ? { error: refreshError } : {}),
  };
}

async function acquireRefreshLock(location, nowMs) {
  await ensureCacheDirectory(location);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = crypto.randomUUID();
    try {
      await fsp.mkdir(location.lock_path, { mode: 0o700 });
      await atomicWriteJson(path.join(location.lock_path, "owner.json"), {
        token,
        pid: process.pid,
        created_at: new Date(nowMs).toISOString(),
      });
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readJsonIfExists(path.join(location.lock_path, "owner.json"))
        .catch(() => null);
      const lockStat = await fsp.stat(location.lock_path).catch(() => null);
      const ownerAgeMs = timestampAgeMs(owner?.created_at, nowMs);
      const ageMs = ownerAgeMs ?? (lockStat ? Math.max(0, nowMs - lockStat.mtimeMs) : null);
      const stale = ageMs !== null && ageMs > REFRESH_LOCK_STALE_MS;
      if (!stale && (!owner || isProcessAlive(owner.pid))) return null;
      await fsp.rm(location.lock_path, { recursive: true, force: true });
    }
  }
  return null;
}

async function ensureCacheDirectory(location) {
  await fsp.mkdir(location.root, { recursive: true, mode: 0o700 });
  await fsp.chmod(location.root, 0o700).catch(() => undefined);
  await fsp.mkdir(location.directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(location.directory, 0o700).catch(() => undefined);
}

async function releaseRefreshLock(location, token) {
  const owner = await readJsonIfExists(path.join(location.lock_path, "owner.json"))
    .catch(() => null);
  if (owner?.token === token) {
    await fsp.rm(location.lock_path, { recursive: true, force: true });
  }
}

function compactError(error) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    code: typeof error?.code === "string" ? error.code : "catalog_cache_error",
    message: message.length > 512 ? `${message.slice(0, 511)}…` : message,
  };
}

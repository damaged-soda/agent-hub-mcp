import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRefreshWorkerEnv,
  getAgentCatalogCacheLocation,
  loadAgentCatalogForStatus,
  refreshAgentCatalogCache,
  storeAgentCatalog,
} from "../src/agent-catalog-cache.js";

describe("agent catalog cache", () => {
  let root;
  let cacheRoot;
  let cwd;
  let env;
  let catalog;
  let nowMs;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-catalog-cache-test-"));
    cacheRoot = path.join(root, "cache");
    cwd = path.join(root, "workspace");
    await fsp.mkdir(cwd);
    env = {
      HOME: root,
      PATH: "/test/bin",
      OPENAI_API_KEY: "must-not-be-persisted",
    };
    catalog = {
      agents: [{
        agent_id: "codex",
        title: "Codex",
        models: [{ id: "gpt-test", display_name: "GPT Test" }],
      }],
      unavailable_agents: [],
    };
    nowMs = Date.parse("2026-08-29T00:00:00.000Z");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("persists a private cross-process cache and serves a fresh hit without discovery", async () => {
    const loadCatalog = vi.fn(async () => catalog);
    const first = await loadAgentCatalogForStatus(options({ load_catalog: loadCatalog }));
    expect(first.cache).toMatchObject({
      status: "refreshed",
      age_seconds: 0,
      refresh: "synchronous",
    });
    expect(loadCatalog).toHaveBeenCalledTimes(1);

    nowMs += 60 * 1000;
    const second = await loadAgentCatalogForStatus(options({
      load_catalog: vi.fn(async () => {
        throw new Error("fresh cache must avoid discovery");
      }),
    }));
    expect(second.catalog).toEqual(catalog);
    expect(second.cache).toMatchObject({
      status: "fresh",
      age_seconds: 60,
      refresh: "not-needed",
    });

    const location = getAgentCatalogCacheLocation(cwd, { env, cache_root: cacheRoot });
    const rootStat = await fsp.stat(cacheRoot);
    expect(rootStat.mode & 0o777).toBe(0o700);
    const stat = await fsp.stat(location.cache_path);
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = await fsp.readFile(location.cache_path, "utf8");
    expect(raw).not.toContain(env.OPENAI_API_KEY);
    expect(raw).not.toContain(cwd);
  });

  it("serves stale data immediately and schedules one detached refresh", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    nowMs += 6 * 60 * 1000;
    const spawnRefresh = vi.fn(async () => undefined);
    const loadCatalog = vi.fn(async () => {
      throw new Error("stale status must not block on discovery");
    });

    const result = await loadAgentCatalogForStatus(options({
      load_catalog: loadCatalog,
      spawn_refresh: spawnRefresh,
    }));

    expect(result.catalog).toEqual(catalog);
    expect(result.cache).toMatchObject({
      status: "stale",
      age_seconds: 360,
      refresh: "scheduled",
    });
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(spawnRefresh).toHaveBeenCalledWith({ cwd, env, cache_root: cacheRoot });
  });

  it("refreshes synchronously after the hard stale window", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    nowMs += 25 * 60 * 60 * 1000;
    const nextCatalog = {
      agents: [{ agent_id: "claude-code", title: "Claude", models: [] }],
      unavailable_agents: [],
    };
    const loadCatalog = vi.fn(async () => nextCatalog);

    const result = await loadAgentCatalogForStatus(options({ load_catalog: loadCatalog }));

    expect(result.catalog).toEqual(nextCatalog);
    expect(result.cache.status).toBe("refreshed");
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight hard refresh instead of racing a second cache write", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    nowMs += 25 * 60 * 60 * 1000;
    const workerCatalog = {
      agents: [{ agent_id: "codex", title: "Worker", models: [{ id: "worker" }] }],
      unavailable_agents: [],
    };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const workerLoad = vi.fn(async () => {
      await gate;
      return workerCatalog;
    });
    const worker = refreshAgentCatalogCache(options({ load_catalog: workerLoad }));
    await vi.waitFor(() => expect(workerLoad).toHaveBeenCalledTimes(1));

    const statusLoad = vi.fn(async () => {
      throw new Error("hard expiry must join the in-flight refresh");
    });
    const status = loadAgentCatalogForStatus(options({
      load_catalog: statusLoad,
      sync_wait_ms: 1000,
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();

    await expect(worker).resolves.toMatchObject({ refreshed: true });
    await expect(status).resolves.toMatchObject({
      catalog: workerCatalog,
      cache: { status: "fresh", refresh: "waited" },
    });
    expect(statusLoad).not.toHaveBeenCalled();
  });

  it("lets a later live catalog write win over an older detached refresh", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    nowMs += 6 * 60 * 1000;
    const workerCatalog = {
      agents: [{ agent_id: "codex", title: "Worker", models: [{ id: "worker" }] }],
      unavailable_agents: [],
    };
    const liveCatalog = {
      agents: [{ agent_id: "codex", title: "Live", models: [{ id: "live" }] }],
      unavailable_agents: [],
    };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const workerLoad = vi.fn(async () => {
      await gate;
      return workerCatalog;
    });
    const worker = refreshAgentCatalogCache(options({ load_catalog: workerLoad }));
    await vi.waitFor(() => expect(workerLoad).toHaveBeenCalledTimes(1));
    const liveWrite = storeAgentCatalog(cwd, liveCatalog, options({ sync_wait_ms: 1000 }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();

    await expect(worker).resolves.toMatchObject({ refreshed: true });
    await expect(liveWrite).resolves.toMatchObject({ stored: true });
    const result = await loadAgentCatalogForStatus(options({
      load_catalog: async () => {
        throw new Error("live cache should be fresh");
      },
    }));
    expect(result.catalog).toEqual(liveCatalog);
  });

  it("uses a cross-process lock to collapse concurrent refreshes", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    nowMs += 6 * 60 * 1000;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const loadCatalog = vi.fn(async () => {
      await gate;
      return catalog;
    });

    const first = refreshAgentCatalogCache(options({ load_catalog: loadCatalog }));
    await vi.waitFor(() => expect(loadCatalog).toHaveBeenCalledTimes(1));
    const second = await refreshAgentCatalogCache(options({ load_catalog: loadCatalog }));
    release();

    await expect(first).resolves.toMatchObject({ refreshed: true });
    expect(second).toEqual({ refreshed: false, reason: "refresh-in-progress" });
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("records a refresh failure and backs off without discarding the stale catalog", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    nowMs += 6 * 60 * 1000;
    await expect(refreshAgentCatalogCache(options({
      load_catalog: async () => {
        const error = new Error("provider discovery failed");
        error.code = "discovery_failed";
        throw error;
      },
    }))).rejects.toThrow("provider discovery failed");

    nowMs += 1000;
    const spawnRefresh = vi.fn(async () => undefined);
    const result = await loadAgentCatalogForStatus(options({
      load_catalog: async () => catalog,
      spawn_refresh: spawnRefresh,
    }));

    expect(result.catalog).toEqual(catalog);
    expect(result.cache).toMatchObject({
      status: "stale",
      refresh: "backoff",
      last_refresh_error: {
        code: "discovery_failed",
        message: "provider discovery failed",
      },
    });
    expect(spawnRefresh).not.toHaveBeenCalled();
  });

  it("records a worker spawn failure and backs off the next status call", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    nowMs += 6 * 60 * 1000;
    const first = await loadAgentCatalogForStatus(options({
      load_catalog: async () => catalog,
      spawn_refresh: async () => {
        throw new Error("worker executable unavailable");
      },
    }));
    expect(first.cache).toMatchObject({
      status: "stale",
      refresh: "start-failed",
      error: { message: "worker executable unavailable" },
    });

    nowMs += 1000;
    const spawnRefresh = vi.fn(async () => undefined);
    const second = await loadAgentCatalogForStatus(options({
      load_catalog: async () => catalog,
      spawn_refresh: spawnRefresh,
    }));
    expect(second.cache.refresh).toBe("backoff");
    expect(spawnRefresh).not.toHaveBeenCalled();
  });

  it("does not let an old spawn failure overwrite a newer live catalog", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    nowMs += 6 * 60 * 1000;
    const liveCatalog = {
      agents: [{ agent_id: "codex", title: "Live", models: [{ id: "live" }] }],
      unavailable_agents: [],
    };
    await loadAgentCatalogForStatus(options({
      load_catalog: async () => catalog,
      spawn_refresh: async () => {
        await storeAgentCatalog(cwd, liveCatalog, options());
        throw new Error("spawn failed after a live update");
      },
    }));

    const result = await loadAgentCatalogForStatus(options({
      load_catalog: async () => {
        throw new Error("newer live catalog should remain fresh");
      },
    }));
    expect(result.catalog).toEqual(liveCatalog);
    expect(result.cache.refresh).toBe("not-needed");
  });

  it("never steals a refresh lock from a live owner, regardless of lock age", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    const location = getAgentCatalogCacheLocation(cwd, { env, cache_root: cacheRoot });
    await fsp.mkdir(location.lock_path, { mode: 0o700 });
    await fsp.writeFile(path.join(location.lock_path, "owner.json"), JSON.stringify({
      token: "live-owner",
      pid: process.pid,
      created_at: "2000-01-01T00:00:00.000Z",
    }));
    const loadCatalog = vi.fn(async () => catalog);

    await expect(refreshAgentCatalogCache(options({ load_catalog: loadCatalog })))
      .resolves.toEqual({ refreshed: false, reason: "refresh-in-progress" });
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it("treats an incompatible cache schema as a miss and rediscovery", async () => {
    await storeAgentCatalog(cwd, catalog, options());
    const location = getAgentCatalogCacheLocation(cwd, { env, cache_root: cacheRoot });
    await fsp.writeFile(location.cache_path, JSON.stringify({
      schema_version: 99,
      kind: "agent-catalog-cache",
      observed_at: new Date(nowMs).toISOString(),
      catalog,
    }));
    const loadCatalog = vi.fn(async () => catalog);

    const result = await loadAgentCatalogForStatus(options({ load_catalog: loadCatalog }));
    expect(result.cache.status).toBe("refreshed");
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it("passes only the Agent discovery allowlist to the detached worker", () => {
    const workerEnv = buildRefreshWorkerEnv({
      ...env,
      OPENAI_API_KEY: "required-provider-credential",
      UNRELATED_SECRET: "must-not-cross-worker-boundary",
      AGENT_HUB_CATALOG_CACHE_DIR: cacheRoot,
      AGENT_HUB_CWD_ALLOWLIST: cwd,
      AGENT_HUB_RUN_DIR: path.join(root, "runs"),
    });

    expect(workerEnv.OPENAI_API_KEY).toBe("required-provider-credential");
    expect(workerEnv.UNRELATED_SECRET).toBeUndefined();
    expect(workerEnv.AGENT_HUB_CATALOG_CACHE_DIR).toBe(cacheRoot);
    expect(workerEnv.AGENT_HUB_CWD_ALLOWLIST).toBe(cwd);
    expect(workerEnv.AGENT_HUB_RUN_DIR).toBe(path.join(root, "runs"));
  });

  function options(extra = {}) {
    return {
      cwd,
      env,
      cache_root: cacheRoot,
      now: () => nowMs,
      ...extra,
    };
  }
});

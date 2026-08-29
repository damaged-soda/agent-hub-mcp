import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

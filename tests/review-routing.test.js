import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchReview,
  getReviewConfigPath,
  reviewStatus,
  setReviewRoute,
} from "../src/review-routing.js";
import { REVIEW_DEPTH_ENV } from "../src/review-context.js";

describe("review routing", () => {
  let root;
  let configPath;
  let catalog;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-review-test-"));
    configPath = path.join(root, "config", "review-routing.json");
    catalog = {
      agents: [
        { agent_id: "codex", title: "Codex", models: [
          { id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
        ] },
        { agent_id: "claude-code", title: "Claude Code", models: [
          { id: "default", display_name: "Default", resolved_id: "claude-opus-5[1m]" },
        ] },
        { agent_id: "kimi-code", title: "Kimi Code", models: [
          { id: "kimi-code/k3", display_name: "K3", resolved_id: "k3" },
        ] },
        { agent_id: "opencode", title: "OpenCode", models: [
          { id: "opencode/big-pickle", display_name: "Big Pickle" },
        ] },
      ],
      unavailable_agents: [],
    };
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("keeps the current Codex to Claude default without creating state", async () => {
    const status = await reviewStatus({}, internal());
    expect(status.kind).toBe("agent-review-config");
    expect(status.routes.find((route) => route.requester === "codex")).toEqual({
      requester: "codex",
      reviewer: "claude-code",
      model: "default",
      resolved_model: "claude-opus-5[1m]",
      source: "default",
      available: true,
      error: null,
    });
    await expect(fsp.access(configPath)).rejects.toThrow();
  });

  it("persists a validated Kimi K3 override and dispatches through it", async () => {
    const updated = await setReviewRoute({
      requester: "codex", reviewer: "kimi-code", model: "kimi-code/k3", cwd: root,
    }, internal());
    expect(updated.routes.find((route) => route.requester === "codex")).toMatchObject({
      reviewer: "kimi-code", model: "kimi-code/k3", resolved_model: "k3",
      source: "override", available: true,
    });
    const dispatch = vi.fn(async () => ({ status: "accepted" }));
    await expect(dispatchReview({
      requester: "codex", cwd: root, prompt: "Review the PR",
    }, internal({ dispatch }))).resolves.toEqual({ status: "accepted" });
    expect(dispatch).toHaveBeenCalledWith(
      {
        agent_id: "kimi-code",
        cwd: root,
        prompt: expect.stringContaining("Review the PR"),
        metadata: { model: "kimi-code/k3" },
      },
      {
        review_context: {
          version: 1,
          requester: "codex",
          reviewer: "kimi-code",
          depth: 1,
        },
      },
    );
    expect(dispatch.mock.calls[0][0].prompt).toContain(
      "Do not invoke `agenthub review dispatch`",
    );
    const saved = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(saved.routes.codex).toEqual({ reviewer: "kimi-code", model: "kimi-code/k3" });
  });

  it("removes an override when the route returns to its default", async () => {
    await setReviewRoute({
      requester: "codex", reviewer: "kimi-code", model: "kimi-code/k3", cwd: root,
    }, internal());
    const status = await setReviewRoute({
      requester: "codex", reviewer: "claude-code", model: "default", cwd: root,
    }, internal());
    expect(status.routes.find((route) => route.requester === "codex").source).toBe("default");
    expect(JSON.parse(await fsp.readFile(configPath, "utf8")).routes).toEqual({});
  });

  it("rejects self review, unknown models, and malformed persisted state", async () => {
    await expect(setReviewRoute({
      requester: "codex", reviewer: "codex", model: "gpt-5.6-sol", cwd: root,
    }, internal())).rejects.toMatchObject({ code: "review_route_invalid" });
    await expect(setReviewRoute({
      requester: "codex", reviewer: "kimi-code", model: "missing", cwd: root,
    }, internal())).rejects.toMatchObject({ code: "review_route_invalid" });
    await expect(dispatchReview({
      requester: "codex", cwd: root, prompt: "",
    }, internal())).rejects.toMatchObject({ code: "review_route_invalid" });
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({ version: 99, routes: {} }));
    await expect(reviewStatus({}, internal())).rejects.toMatchObject({
      code: "review_config_invalid",
    });
  });

  it("marks a configured route unavailable instead of silently falling back", async () => {
    await setReviewRoute({
      requester: "codex", reviewer: "kimi-code", model: "kimi-code/k3", cwd: root,
    }, internal());
    catalog.agents = catalog.agents.filter((agent) => agent.agent_id !== "kimi-code");
    const route = (await reviewStatus({}, internal())).routes.find(
      (item) => item.requester === "codex",
    );
    expect(route).toMatchObject({ available: false, error: "reviewer-unavailable" });
    await expect(dispatchReview({
      requester: "codex", cwd: root, prompt: "Review",
    }, internal())).rejects.toMatchObject({ code: "review_route_invalid" });
  });

  it("reports model discovery failure separately from a missing model", async () => {
    catalog.agents.find((agent) => agent.agent_id === "codex").model_discovery = {
      status: "unavailable",
      source: "codex-models",
      reason: "sandbox denied provider state directory",
    };
    const status = await reviewStatus({}, internal());
    expect(status.routes.find((route) => route.requester === "claude-code")).toMatchObject({
      available: false,
      error: "model-discovery-unavailable",
      error_detail: "sandbox denied provider state directory",
    });
    await expect(dispatchReview({
      requester: "claude-code", cwd: root, prompt: "Review",
    }, internal())).rejects.toMatchObject({
      code: "review_model_discovery_failed",
      message: expect.stringContaining("sandbox denied provider state directory"),
    });
  });

  it("rejects nested review dispatch before discovering agents", async () => {
    const listAgents = vi.fn(async () => catalog);
    await expect(dispatchReview({
      requester: "codex", cwd: root, prompt: "Review",
    }, internal({
      env: { [REVIEW_DEPTH_ENV]: "1" },
      listAgents,
    }))).rejects.toMatchObject({ code: "nested_review_forbidden" });
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("caches status across processes while set and dispatch keep live validation", async () => {
    const listAgents = vi.fn(async () => catalog);
    const cacheRoot = path.join(root, "catalog-cache");
    const cachedInternal = {
      configPath,
      listAgents,
      env: { HOME: root, PATH: "/test/bin" },
      catalogCache: {
        cache_root: cacheRoot,
        now: () => Date.parse("2026-08-29T00:00:00.000Z"),
      },
    };

    const first = await reviewStatus({ cwd: root }, cachedInternal);
    const second = await reviewStatus({ cwd: root }, cachedInternal);
    expect(first.catalog_cache.status).toBe("refreshed");
    expect(second.catalog_cache.status).toBe("fresh");
    expect(listAgents).toHaveBeenCalledTimes(1);

    await setReviewRoute({
      requester: "codex", reviewer: "kimi-code", model: "kimi-code/k3", cwd: root,
    }, cachedInternal);
    expect(listAgents).toHaveBeenCalledTimes(2);

    const dispatch = vi.fn(async () => ({ status: "accepted" }));
    await dispatchReview({ requester: "codex", cwd: root, prompt: "Review" }, {
      ...cachedInternal,
      dispatch,
    });
    expect(listAgents).toHaveBeenCalledTimes(3);
  });

  it("resolves the config path from the explicit override or XDG config home", () => {
    expect(getReviewConfigPath({ AGENT_HUB_REVIEW_CONFIG: "./route.json" }))
      .toBe(path.resolve("route.json"));
    expect(getReviewConfigPath({ XDG_CONFIG_HOME: root }))
      .toBe(path.join(root, "agent-hub-mcp", "review-routing.json"));
  });

  function internal(extra = {}) {
    return {
      configPath,
      listAgents: async () => catalog,
      catalogCache: false,
      ...extra,
    };
  }
});

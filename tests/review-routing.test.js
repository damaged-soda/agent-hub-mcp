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

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-review-test-"));
    configPath = path.join(root, "config", "review-routing.json");

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
      source: "default",
    });
    await expect(fsp.access(configPath)).rejects.toThrow();
  });

  it("persists a Kimi K3 override and dispatches through it", async () => {
    const updated = await setReviewRoute({
      requester: "codex", reviewer: "kimi-code", model: "kimi-code/k3", cwd: root,
    }, internal());
    expect(updated.routes.find((route) => route.requester === "codex")).toMatchObject({
      reviewer: "kimi-code", model: "kimi-code/k3",
      source: "override",
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

  it("dispatches the stored route without agent or model discovery", async () => {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({
      version: 1,
      routes: {
        codex: { reviewer: "opencode", model: "opencode/big-pickle" },
      },
    }));
    const listAgents = vi.fn(async () => {
      throw new Error("model discovery must not run during dispatch");
    });
    const dispatch = vi.fn(async () => ({ status: "accepted" }));

    await expect(dispatchReview({
      requester: "codex", cwd: root, prompt: "Review",
    }, internal({ listAgents, dispatch }))).resolves.toEqual({ status: "accepted" });

    expect(listAgents).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "opencode",
        metadata: { model: "opencode/big-pickle" },
      }),
      expect.any(Object),
    );
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

  it("rejects self review, empty models, unknown agents, and malformed persisted state", async () => {
    await expect(setReviewRoute({
      requester: "codex", reviewer: "codex", model: "gpt-5.6-sol", cwd: root,
    }, internal())).rejects.toMatchObject({ code: "review_route_invalid" });
    await expect(setReviewRoute({
      requester: "codex", reviewer: "kimi-code", model: "", cwd: root,
    }, internal())).rejects.toMatchObject({ code: "review_route_invalid" });
    await expect(setReviewRoute({
      requester: "codex", reviewer: "missing-agent", model: "model", cwd: root,
    }, internal())).rejects.toMatchObject({
      code: "review_route_invalid",
      message: "unsupported reviewer: missing-agent",
    });
    await expect(dispatchReview({
      requester: "codex", cwd: root, prompt: "",
    }, internal())).rejects.toMatchObject({ code: "review_route_invalid" });
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({
      version: 1,
      routes: { codex: { reviewer: "missing-agent", model: "model" } },
    }));
    await expect(dispatchReview({
      requester: "codex", cwd: root, prompt: "Review",
    }, internal())).rejects.toMatchObject({
      code: "review_config_invalid",
      message: "unsupported reviewer: missing-agent",
    });
    await fsp.writeFile(configPath, JSON.stringify({ version: 99, routes: {} }));
    await expect(reviewStatus({}, internal())).rejects.toMatchObject({
      code: "review_config_invalid",
    });
  });

  it("rejects nested review dispatch before reading the route", async () => {
    const listAgents = vi.fn(() => { throw new Error("must not probe providers"); });
    await expect(dispatchReview({
      requester: "codex", cwd: root, prompt: "Review",
    }, internal({
      env: { [REVIEW_DEPTH_ENV]: "1" },
      listAgents,
    }))).rejects.toMatchObject({ code: "nested_review_forbidden" });
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("reads and sets effective routes with no provider probes or cache state", async () => {
    const listAgents = vi.fn(() => { throw new Error("must not probe providers"); });
    const options = internal({ listAgents, env: { HOME: root, PATH: "/missing" } });
    const initial = await reviewStatus({ cwd: root }, options);
    expect(Object.keys(initial).sort()).toEqual(["api_version", "kind", "routes"]);
    expect(await fsp.readdir(root)).toEqual([]);
    await setReviewRoute({
      requester: "codex", reviewer: "opencode", model: "future/model", cwd: root,
    }, options);
    const status = await reviewStatus({ cwd: root }, options);
    expect(status.routes.find((route) => route.requester === "codex")).toEqual({
      requester: "codex", reviewer: "opencode", model: "future/model", source: "override",
    });
    expect(await fsp.readdir(root)).toEqual(["config"]);
    expect(listAgents).not.toHaveBeenCalled();
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
      env: { [REVIEW_DEPTH_ENV]: "" },
      ...extra,
    };
  }
});

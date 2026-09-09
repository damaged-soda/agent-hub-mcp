import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allAdapters } from "./adapters.js";
import { atomicWriteJson, nowIso, readJsonIfExists, withStateLock } from "./fs-store.js";
import { dispatchToAgent } from "./runs.js";
import {
  assertReviewDispatchAllowed,
  createReviewContext,
} from "./review-context.js";
import { buildReviewPrompt } from "./review-prompts.js";
import { validateRequestPaths } from "./security.js";

const REVIEW_CONFIG_VERSION = 1;
const REVIEW_CONFIG_KIND = "agent-review-config";

export const DEFAULT_REVIEW_ROUTES = Object.freeze({
  codex: Object.freeze({ reviewer: "claude-code", model: "default" }),
  "claude-code": Object.freeze({ reviewer: "codex", model: "gpt-5.6-sol" }),
  "kimi-code": Object.freeze({ reviewer: "codex", model: "gpt-5.6-sol" }),
});

export function getReviewConfigPath(env = process.env) {
  if (env.AGENT_HUB_REVIEW_CONFIG) {
    return path.resolve(env.AGENT_HUB_REVIEW_CONFIG);
  }
  const configHome = env.XDG_CONFIG_HOME
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "agent-hub-mcp", "review-routing.json");
}

export async function reviewStatus(input = {}, internal = {}) {
  const configPath = internal.configPath ?? getReviewConfigPath(internal.env);
  // Kept as a config query: no provider processes, model discovery, or cache writes.
  const config = await readReviewConfig(configPath);
  return buildStatus(config);
}

export async function setReviewRoute(input, internal = {}) {
  const requester = requiredString(input?.requester, "requester");
  const reviewer = requiredString(input?.reviewer, "reviewer");
  const model = requiredString(input?.model, "model");
  assertRequester(requester);
  assertReviewer(reviewer);
  if (reviewer === requester) {
    throw reviewRouteError("reviewer must differ from requester");
  }

  const configPath = internal.configPath ?? getReviewConfigPath(internal.env);

  let updated;
  await fsp.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.dirname(configPath), 0o700).catch(() => undefined);
  await withStateLock(path.dirname(configPath), async () => {
    const current = await readReviewConfig(configPath);
    const routes = { ...current.routes };
    if (sameRoute(DEFAULT_REVIEW_ROUTES[requester], { reviewer, model })) {
      delete routes[requester];
    } else {
      routes[requester] = { reviewer, model };
    }
    await atomicWriteJson(configPath, {
      version: REVIEW_CONFIG_VERSION,
      updated_at: nowIso(),
      routes,
    });
    updated = { routes };
  });

  return buildStatus(updated);
}

export async function dispatchReview(input, internal = {}) {
  assertReviewDispatchAllowed(internal.env ?? process.env);
  const requester = requiredString(input?.requester, "requester");
  assertRequester(requester);
  const prompt = requiredString(input?.prompt, "prompt");
  const configPath = internal.configPath ?? getReviewConfigPath(internal.env);
  await resolveReviewCwd(input.cwd);
  const config = await readReviewConfig(configPath);
  const route = effectiveRoute(requester, config);
  assertReviewer(route.reviewer);
  // The target CLI validates the saved model when the review actually runs.
  const reviewContext = createReviewContext({
    requester,
    reviewer: route.reviewer,
  });
  return (internal.dispatch ?? dispatchToAgent)(
    {
      agent_id: route.reviewer,
      cwd: input.cwd,
      prompt: buildReviewPrompt({
        requester,
        reviewer: route.reviewer,
        prompt,
      }),
      metadata: { model: route.model },
    },
    { review_context: reviewContext },
  );
}

async function readReviewConfig(configPath) {
  let document;
  try {
    document = await readJsonIfExists(configPath);
  } catch (error) {
    throw reviewConfigError(`cannot read review config: ${error.message}`);
  }
  if (document === null) return { routes: {} };
  if (!document || document.version !== REVIEW_CONFIG_VERSION ||
      !document.routes || typeof document.routes !== "object" ||
      Array.isArray(document.routes)) {
    throw reviewConfigError("review config contract is invalid");
  }
  const routes = {};
  for (const [requester, route] of Object.entries(document.routes)) {
    assertRequester(requester, reviewConfigError);
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      throw reviewConfigError(`review route ${requester} is invalid`);
    }
    const reviewer = configString(route.reviewer, `routes.${requester}.reviewer`);
    const model = configString(route.model, `routes.${requester}.model`);
    assertReviewer(reviewer, reviewConfigError);
    if (reviewer === requester) {
      throw reviewConfigError(`review route ${requester} cannot review itself`);
    }
    routes[requester] = { reviewer, model };
  }
  return { routes };
}

function buildStatus(config) {
  return {
    api_version: REVIEW_CONFIG_VERSION,
    kind: REVIEW_CONFIG_KIND,
    routes: Object.keys(DEFAULT_REVIEW_ROUTES).map((requester) => ({
      requester,
      ...effectiveRoute(requester, config),
      source: config.routes[requester] ? "override" : "default",
    })),
  };
}

async function resolveReviewCwd(value) {
  if (value === undefined) return process.cwd();
  return (await validateRequestPaths(value)).cwd;
}

function effectiveRoute(requester, config) {
  return config.routes[requester] ?? DEFAULT_REVIEW_ROUTES[requester];
}

function assertRequester(requester, errorFactory = reviewRouteError) {
  const requesters = new Set(allAdapters().map((adapter) => adapter.agentId));
  if (!requesters.has(requester) || !DEFAULT_REVIEW_ROUTES[requester]) {
    throw errorFactory(`unsupported requester: ${requester}`);
  }
}

function assertReviewer(reviewer, errorFactory = reviewRouteError) {
  if (!allAdapters().some((adapter) => adapter.agentId === reviewer)) {
    throw errorFactory(`unsupported reviewer: ${reviewer}`);
  }
}

function sameRoute(left, right) {
  return left?.reviewer === right.reviewer && left?.model === right.model;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw reviewRouteError(`${field} must be a non-empty string`);
  }
  return value;
}

function configString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw reviewConfigError(`${field} must be a non-empty string`);
  }
  return value;
}

function reviewConfigError(message) {
  const error = new Error(message);
  error.code = "review_config_invalid";
  return error;
}

function reviewRouteError(message, code = "review_route_invalid") {
  const error = new Error(message);
  error.code = code;
  return error;
}

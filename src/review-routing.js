import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allAdapters } from "./adapters.js";
import { atomicWriteJson, nowIso, readJsonIfExists, withStateLock } from "./fs-store.js";
import { dispatchToAgent, listAgents } from "./runs.js";

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
  const catalog = await (internal.listAgents ?? listAgents)({ cwd: input.cwd });
  const config = await readReviewConfig(configPath);
  return buildStatus(config, catalog);
}

export async function setReviewRoute(input, internal = {}) {
  const requester = requiredString(input?.requester, "requester");
  const reviewer = requiredString(input?.reviewer, "reviewer");
  const model = requiredString(input?.model, "model");
  assertRequester(requester);
  if (reviewer === requester) {
    throw reviewRouteError("reviewer must differ from requester");
  }

  const configPath = internal.configPath ?? getReviewConfigPath(internal.env);
  const catalog = await (internal.listAgents ?? listAgents)({ cwd: input.cwd });
  assertAvailableRoute(reviewer, model, catalog);

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
  });

  return reviewStatus(input, { ...internal, configPath, listAgents: async () => catalog });
}

export async function dispatchReview(input, internal = {}) {
  const requester = requiredString(input?.requester, "requester");
  assertRequester(requester);
  const prompt = requiredString(input?.prompt, "prompt");
  const configPath = internal.configPath ?? getReviewConfigPath(internal.env);
  const catalog = await (internal.listAgents ?? listAgents)({ cwd: input.cwd });
  const config = await readReviewConfig(configPath);
  const route = effectiveRoute(requester, config);
  assertAvailableRoute(route.reviewer, route.model, catalog);
  return (internal.dispatch ?? dispatchToAgent)({
    agent_id: route.reviewer,
    cwd: input.cwd,
    prompt,
    metadata: { model: route.model },
  });
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
    if (reviewer === requester) {
      throw reviewConfigError(`review route ${requester} cannot review itself`);
    }
    routes[requester] = { reviewer, model };
  }
  return { routes };
}

function buildStatus(config, catalog) {
  const available = new Map((catalog.agents ?? []).map((agent) => [agent.agent_id, agent]));
  const routes = Object.keys(DEFAULT_REVIEW_ROUTES).map((requester) => {
    const route = effectiveRoute(requester, config);
    const agent = available.get(route.reviewer);
    const model = agent?.models?.find((item) => item.id === route.model);
    const error = !agent ? "reviewer-unavailable" : !model ? "model-unavailable" : null;
    return {
      requester,
      reviewer: route.reviewer,
      model: route.model,
      resolved_model: model?.resolved_id ?? model?.id ?? null,
      source: config.routes[requester] ? "override" : "default",
      available: error === null,
      error,
    };
  });
  return {
    api_version: REVIEW_CONFIG_VERSION,
    kind: REVIEW_CONFIG_KIND,
    routes,
    agents: catalog.agents ?? [],
    unavailable_agents: catalog.unavailable_agents ?? [],
  };
}

function effectiveRoute(requester, config) {
  return config.routes[requester] ?? DEFAULT_REVIEW_ROUTES[requester];
}

function assertAvailableRoute(reviewer, model, catalog) {
  const agent = (catalog.agents ?? []).find((item) => item.agent_id === reviewer);
  if (!agent) throw reviewRouteError(`reviewer is unavailable: ${reviewer}`);
  if (!(agent.models ?? []).some((item) => item.id === model)) {
    throw reviewRouteError(`model is unavailable for ${reviewer}: ${model}`);
  }
}

function assertRequester(requester, errorFactory = reviewRouteError) {
  const requesters = new Set(allAdapters().map((adapter) => adapter.agentId));
  if (!requesters.has(requester) || !DEFAULT_REVIEW_ROUTES[requester]) {
    throw errorFactory(`unsupported requester: ${requester}`);
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

function reviewRouteError(message) {
  const error = new Error(message);
  error.code = "review_route_invalid";
  return error;
}

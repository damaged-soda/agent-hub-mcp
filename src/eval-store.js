import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson, expiresAt } from "./fs-store.js";

const DEFAULT_TTL_SECONDS = 604800;

export function getEvalRoot(env = process.env) {
  if (env.AGENT_HUB_EVAL_DIR) {
    return path.resolve(env.AGENT_HUB_EVAL_DIR);
  }
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "agent-hub-mcp", "evals");
}

export function evalTtlSeconds(env = process.env) {
  const raw = env.AGENT_HUB_EVAL_TTL_SECONDS ?? env.AGENT_HUB_RUN_TTL_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("AGENT_HUB_EVAL_TTL_SECONDS must be a non-negative number");
  }
  return value;
}

export async function writeEvalResult(document, env = process.env) {
  const root = getEvalRoot(env);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700).catch(() => undefined);
  const target = path.join(root, `${document.eval_run_id}.json`);
  await atomicWriteJson(target, document);
  await fsp.chmod(target, 0o600).catch(() => undefined);
  return target;
}

export async function cleanupExpiredEvalResults(env = process.env) {
  const root = getEvalRoot(env);
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const target = path.join(root, entry.name);
        let document;
        try {
          document = JSON.parse(await fsp.readFile(target, "utf8"));
        } catch {
          return;
        }
        const expiry = Date.parse(document.expires_at ?? "");
        if (Number.isFinite(expiry) && expiry <= now) {
          await fsp.rm(target, { force: true });
        }
      }),
  );
}

export function evalExpiresAt(from = new Date(), env = process.env) {
  return expiresAt(from, evalTtlSeconds(env));
}

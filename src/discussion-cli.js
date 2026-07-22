import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, readJsonIfExists } from "./fs-store.js";
import { DiscussionManager } from "./discussion-manager.js";
import {
  DISCUSSION_FINAL_STATUSES,
  discussionLeaseIsLive,
  ensureDiscussionRoot,
  readDiscussionState,
} from "./discussion-store.js";

const WORKER_PATH = fileURLToPath(new URL("./discussion-worker.js", import.meta.url));
const DISPATCH_ACK_TIMEOUT_MS = 30000;
const CLI_COMMAND_TTL_MS = 60 * 60 * 1000;

export async function dispatchDiscussionFromCli(input, options = {}) {
  const root = await prepareDiscussionCliRoot();
  const commandDir = path.join(root, ".cli-commands", crypto.randomUUID());
  const requestPath = path.join(commandDir, "request.json");
  const responsePath = path.join(commandDir, "response.json");
  await fsp.mkdir(commandDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(commandDir, 0o700).catch(() => undefined);
  await atomicWriteJson(requestPath, input);

  const worker = await spawnDiscussionWorker(["dispatch", requestPath, responsePath]);
  try {
    const response = await waitForWorkerResponse(
      responsePath,
      worker,
      options.ack_timeout_ms ?? DISPATCH_ACK_TIMEOUT_MS,
    );
    if (!response.ok) throw deserializeWorkerError(response.error);
    return response.value;
  } finally {
    await fsp.rm(commandDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function queryDiscussionFromCli(input) {
  await ensureDiscussionWorker(input?.discussion_ref?.discussion_id);
  return withPassiveManager((manager) => manager.query(input));
}

export async function waitDiscussionFromCli(input, options = {}) {
  await ensureDiscussionWorker(input?.discussion_ref?.discussion_id);
  return withPassiveManager(
    (manager) => manager.wait(input),
    { wait_window_ms: options.timeout_ms },
  );
}

export async function cancelDiscussionFromCli(input) {
  const result = await withPassiveManager((manager) => manager.cancel(input));
  await ensureDiscussionWorker(input?.discussion_ref?.discussion_id);
  return result;
}

async function withPassiveManager(fn, options = {}) {
  const manager = new DiscussionManager({
    auto_resume: false,
    ...(Number.isFinite(options.wait_window_ms)
      ? { wait_window_ms: options.wait_window_ms }
      : {}),
  });
  await manager.start({ recover_existing: false });
  try {
    return await fn(manager);
  } finally {
    await manager.shutdown();
  }
}

async function ensureDiscussionWorker(id) {
  await prepareDiscussionCliRoot();
  const state = await readDiscussionState(id);
  if (
    DISCUSSION_FINAL_STATUSES.has(state.status) ||
    !state.preflight_complete ||
    (await discussionLeaseIsLive(id))
  ) {
    return;
  }
  await spawnDiscussionWorker(["resume", id]);
}

async function prepareDiscussionCliRoot() {
  const root = await ensureDiscussionRoot();
  const commandRoot = path.join(root, ".cli-commands");
  let entries;
  try {
    entries = await fsp.readdir(commandRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return root;
    throw error;
  }
  const cutoff = Date.now() - CLI_COMMAND_TTL_MS;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const target = path.join(commandRoot, entry.name);
      const stat = await fsp.stat(target).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
    }),
  );
  return root;
}

async function spawnDiscussionWorker(args) {
  const root = await ensureDiscussionRoot();
  const log = await fsp.open(path.join(root, ".workers.log"), "a", 0o600);
  await log.chmod(0o600).catch(() => undefined);
  let child;
  let started;
  try {
    child = spawn(process.execPath, [WORKER_PATH, ...args], {
      detached: true,
      env: { ...process.env, AGENT_HUB_DISCUSSION_WORKER: "1" },
      stdio: ["ignore", log.fd, log.fd],
    });
    started = new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    await log.close();
  }
  await started;
  child.unref();
  return child;
}

async function waitForWorkerResponse(responsePath, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await readJsonIfExists(responsePath);
    if (response) return response;
    if (child.exitCode !== null) {
      throw codedError(
        "discussion_worker_exited",
        `Discussion worker exited before accepting the request (exit ${child.exitCode})`,
      );
    }
    await sleep(25);
  }
  throw codedError(
    "discussion_worker_timeout",
    `Discussion worker did not accept the request within ${timeoutMs}ms`,
  );
}

function deserializeWorkerError(value) {
  const error = new Error(value?.message ?? "Discussion worker failed");
  if (value?.code) error.code = value.code;
  if (value?.stack) error.stack = value.stack;
  return error;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

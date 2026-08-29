#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./fs-store.js";
import { DiscussionManager } from "./discussion-manager.js";

let manager;
let shuttingDown = false;
let workerMode = null;
let discussionId = null;
let commandId = null;

async function main() {
  const [mode, first, second] = process.argv.slice(2);
  workerMode = mode ?? null;
  discussionId = mode === "resume" ? first ?? null : null;
  commandId = mode === "dispatch" && first ? path.basename(path.dirname(first)) : null;
  logWorkerEvent("worker.started");
  manager = new DiscussionManager({
    log_diagnostic: (diagnostic) => logWorkerEvent(diagnostic.event, diagnostic.error),
  });
  installShutdownHandlers();
  await manager.start({ recover_existing: false });

  if (mode === "dispatch") {
    if (!first || !second) {
      throw new Error("Usage: discussion-worker dispatch <request-path> <response-path>");
    }
    await dispatch(first, second);
    logWorkerEvent("worker.completed");
    return;
  }
  if (mode === "resume") {
    if (!first) throw new Error("Usage: discussion-worker resume <discussion-id>");
    await manager.resume(first);
    await manager.waitForController(first);
    await manager.shutdown();
    logWorkerEvent("worker.completed");
    return;
  }
  throw new Error("Discussion worker mode must be dispatch or resume");
}

async function dispatch(requestPath, responsePath) {
  let accepted;
  try {
    const input = JSON.parse(await fsp.readFile(requestPath, "utf8"));
    accepted = await manager.dispatch(input);
    discussionId = accepted.discussion_ref.discussion_id;
    logWorkerEvent("discussion.accepted");
    await atomicWriteJson(responsePath, { ok: true, value: accepted });
  } catch (error) {
    await atomicWriteJson(responsePath, {
      ok: false,
      error: serializeError(error),
    }).catch(() => undefined);
    throw error;
  }
  await manager.waitForController(accepted.discussion_ref.discussion_id);
  await manager.shutdown();
}

function installShutdownHandlers() {
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logWorkerEvent("worker.shutdown_requested");
    void manager.shutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function serializeError(error) {
  return {
    code: error?.code,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

function logWorkerEvent(event, error = null) {
  const record = {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    event,
    mode: workerMode,
    discussion_id: discussionId,
    command_id: commandId,
    pid: process.pid,
  };
  if (error) {
    record.error = {
      code: error?.code ?? "discussion_worker_error",
      message: compactLogMessage(error instanceof Error ? error.message : String(error)),
    };
  }
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function compactLogMessage(value) {
  const normalized = String(value).replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 4096 ? `${normalized.slice(0, 4095)}…` : normalized;
}

main().catch((error) => {
  logWorkerEvent("worker.failed", error);
  process.exit(1);
});

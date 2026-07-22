#!/usr/bin/env node
import fsp from "node:fs/promises";
import { atomicWriteJson } from "./fs-store.js";
import { DiscussionManager } from "./discussion-manager.js";

let manager;
let shuttingDown = false;

async function main() {
  const [mode, first, second] = process.argv.slice(2);
  manager = new DiscussionManager();
  installShutdownHandlers();
  await manager.start({ recover_existing: false });

  if (mode === "dispatch") {
    if (!first || !second) {
      throw new Error("Usage: discussion-worker dispatch <request-path> <response-path>");
    }
    await dispatch(first, second);
    return;
  }
  if (mode === "resume") {
    if (!first) throw new Error("Usage: discussion-worker resume <discussion-id>");
    await manager.resume(first);
    await manager.waitForController(first);
    await manager.shutdown();
    return;
  }
  throw new Error("Discussion worker mode must be dispatch or resume");
}

async function dispatch(requestPath, responsePath) {
  let accepted;
  try {
    const input = JSON.parse(await fsp.readFile(requestPath, "utf8"));
    accepted = await manager.dispatch(input);
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

main().catch((error) => {
  process.stderr.write(
    `agenthub discussion worker error: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
});

#!/usr/bin/env node
import path from "node:path";
import { refreshAgentCatalogCache } from "./agent-catalog-cache.js";
import { listAgents } from "./runs.js";

async function main() {
  const [rawCwd, cacheRoot] = process.argv.slice(2);
  if (!rawCwd || !path.isAbsolute(rawCwd)) {
    throw new Error("agent catalog refresh worker requires an absolute cwd");
  }
  await refreshAgentCatalogCache({
    cwd: rawCwd,
    env: process.env,
    ...(cacheRoot ? { cache_root: path.resolve(cacheRoot) } : {}),
    load_catalog: () => listAgents({ cwd: rawCwd }),
  });
}

main().catch(() => {
  process.exitCode = 1;
});

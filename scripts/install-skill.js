#!/usr/bin/env node
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "skills", "agent-hub");
const skillsRoot = path.resolve(
  process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "skills") : path.join(os.homedir(), ".codex", "skills"),
);
const target = path.join(skillsRoot, "agent-hub");
const staging = path.join(skillsRoot, `.agent-hub.${process.pid}.tmp`);

await fsp.mkdir(skillsRoot, { recursive: true, mode: 0o700 });
await fsp.rm(staging, { recursive: true, force: true });
await fsp.cp(source, staging, { recursive: true, force: true });
await fsp.rm(target, { recursive: true, force: true });
await fsp.rename(staging, target);
process.stdout.write(`${target}\n`);

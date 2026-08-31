#!/usr/bin/env node
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledSkillsRoot = path.join(repoRoot, "skills");
const skillsRoot = path.resolve(
  process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "skills") : path.join(os.homedir(), ".codex", "skills"),
);

await fsp.mkdir(skillsRoot, { recursive: true, mode: 0o700 });
const entries = await fsp.readdir(bundledSkillsRoot, { withFileTypes: true });
const skillNames = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (skillNames.length === 0) {
  throw new Error(`No bundled skills found under ${bundledSkillsRoot}`);
}

const installed = [];
for (const skillName of skillNames) {
  if (!/^[a-z0-9-]+$/.test(skillName)) {
    throw new Error(`Invalid bundled skill directory name: ${skillName}`);
  }

  const source = path.join(bundledSkillsRoot, skillName);
  await fsp.access(path.join(source, "SKILL.md"));
  const target = path.join(skillsRoot, skillName);
  const staging = path.join(skillsRoot, `.${skillName}.${process.pid}.tmp`);
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.cp(source, staging, { recursive: true, force: true });
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(staging, target);
  installed.push(target);
}

process.stdout.write(`${installed.join("\n")}\n`);

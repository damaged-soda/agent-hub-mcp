import fsp from "node:fs/promises";
import path from "node:path";

function splitAllowlist(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function realpathExisting(target, label) {
  try {
    return await fsp.realpath(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${target}`);
    }
    throw error;
  }
}

async function realpathTarget(target) {
  return fsp.realpath(target);
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function validateDirectory(target, label, baseDir = process.cwd()) {
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return realpathTarget(resolved);
}

export async function validateAllowlist(targets) {
  const allowlist = splitAllowlist(process.env.AGENT_HUB_CWD_ALLOWLIST);
  if (allowlist.length === 0) {
    return;
  }
  const roots = await Promise.all(
    allowlist.map((entry) =>
      realpathExisting(path.resolve(entry), "AGENT_HUB_CWD_ALLOWLIST entry"),
    ),
  );
  for (const { path: target, label } of targets) {
    const realTarget = await realpathTarget(path.resolve(target));
    if (!roots.some((root) => isInside(realTarget, root))) {
      throw new Error(`${label} is outside AGENT_HUB_CWD_ALLOWLIST`);
    }
  }
}

export async function validateRequestPaths(cwd, metadata = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path");
  }
  const realCwd = await validateDirectory(cwd, "cwd");
  const addDirs = metadata?.claude?.add_dirs ?? [];
  if (addDirs !== undefined && !Array.isArray(addDirs)) {
    throw new Error("metadata.claude.add_dirs must be an array");
  }
  const realAddDirs = [];
  for (const [index, addDir] of addDirs.entries()) {
    realAddDirs.push(
      await validateDirectory(addDir, `metadata.claude.add_dirs[${index}]`, realCwd),
    );
  }
  await validateAllowlist([
    { path: realCwd, label: "cwd" },
    ...realAddDirs.map((item, index) => ({
      path: item,
      label: `metadata.claude.add_dirs[${index}]`,
    })),
  ]);
  return { cwd: realCwd, addDirs: realAddDirs };
}

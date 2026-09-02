import fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./adapter-utils.js";

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_PYTHON_FALLBACKS = Object.freeze(["/usr/bin/python3"]);
export const PYTHON_RUNTIME_PROBE_ARGS = Object.freeze([
  "-I",
  "-S",
  "-c",
  "import json,sys; print(json.dumps([sys.executable,sys.prefix,sys.base_prefix]))",
]);
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROBE_ENV_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
]);

export async function detectPythonRuntime(env = process.env, internal = {}) {
  const timeoutMs = probeTimeout(internal.timeout_ms);
  const fallbackCandidates = fallbackExecutables(internal.fallback_candidates);
  const forbiddenRoots = await normalizeForbiddenRoots(internal.forbidden_roots);
  const probeEnv = pythonProbeEnvironment(env);
  const pathCandidates = String(env?.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry, "python3"));
  const candidates = Array.from(new Set([...pathCandidates, ...fallbackCandidates]));

  for (const candidate of candidates) {
    if (!await isExecutableFile(candidate)) continue;
    if (await overlapsForbiddenRoot(candidate, forbiddenRoots)) continue;
    const discovered = await probePython(candidate, probeEnv, timeoutMs);
    if (!discovered) continue;
    if (!await isExecutableFile(discovered.executable)) continue;

    // A PATH candidate may be a shim or a namespace symlink. Resolve the absolute
    // sys.executable it reports, then probe that canonical file directly. Only this
    // second probe defines the runtime identity and capabilities.
    const canonicalExecutable = await fsp.realpath(discovered.executable).catch(() => null);
    if (!canonicalExecutable || !await isExecutableFile(canonicalExecutable)) continue;
    if (await overlapsForbiddenRoot(canonicalExecutable, forbiddenRoots)) continue;
    const identity = await probePython(canonicalExecutable, probeEnv, timeoutMs);
    if (!identity || !await validCanonicalIdentity(identity, canonicalExecutable)) continue;

    const readPaths = await runtimeReadPaths(canonicalExecutable, identity);
    if (
      !readPaths ||
      await includesUnsafeRoot(readPaths, env) ||
      await anyOverlapsForbiddenRoot(readPaths, forbiddenRoots)
    ) continue;
    return {
      executable: canonicalExecutable,
      read_paths: readPaths,
      identity,
    };
  }
  return null;
}

export async function createRuntimeCommandBin(parent, commands) {
  if (typeof parent !== "string" || !path.isAbsolute(parent)) {
    throw new Error("Runtime command-bin parent must be an absolute directory");
  }
  const realParent = await fsp.realpath(parent);
  const parentStat = await fsp.stat(realParent);
  if (!parentStat.isDirectory()) {
    throw new Error("Runtime command-bin parent must be a directory");
  }
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    throw new Error("Runtime commands must be a non-empty object");
  }
  const entries = Object.entries(commands);
  if (entries.length === 0) {
    throw new Error("Runtime commands must be a non-empty object");
  }

  const normalized = [];
  for (const [name, executable] of entries) {
    if (!COMMAND_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid runtime command name: ${JSON.stringify(name)}`);
    }
    if (typeof executable !== "string" || !path.isAbsolute(executable)) {
      throw new Error(`Runtime command ${name} must use an absolute executable`);
    }
    const absolute = path.resolve(executable);
    if (!await isExecutableFile(absolute)) {
      throw new Error(`Runtime command ${name} executable is unavailable`);
    }
    const canonical = await fsp.realpath(absolute);
    if (!await isExecutableFile(canonical)) {
      throw new Error(`Runtime command ${name} executable is unavailable`);
    }
    normalized.push([name, canonical]);
  }

  const commandBin = path.join(realParent, "runtime-bin");
  await fsp.mkdir(commandBin, { mode: 0o700 });
  try {
    await fsp.chmod(commandBin, 0o700);
    for (const [name, executable] of normalized) {
      await fsp.symlink(executable, path.join(commandBin, name));
    }
    await fsp.chmod(commandBin, 0o555);
    return await fsp.realpath(commandBin);
  } catch (error) {
    await fsp.chmod(commandBin, 0o700).catch(() => undefined);
    await fsp.rm(commandBin, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function probePython(executable, env, timeoutMs) {
  const result = await runCommand(executable, PYTHON_RUNTIME_PROBE_ARGS, {
    env,
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });
  if (result.error || result.code !== 0) return null;
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((item) => typeof item !== "string" || !path.isAbsolute(item))
  ) {
    return null;
  }
  return {
    executable: path.resolve(value[0]),
    prefix: path.resolve(value[1]),
    base_prefix: path.resolve(value[2]),
  };
}

async function validCanonicalIdentity(identity, canonicalExecutable) {
  if (!await isExecutableFile(identity.executable)) return false;
  const identityExecutable = await fsp.realpath(identity.executable).catch(() => null);
  if (identityExecutable !== canonicalExecutable) return false;
  const prefix = await canonicalDirectory(identity.prefix);
  const basePrefix = await canonicalDirectory(identity.base_prefix);
  if (!prefix || !basePrefix) return false;
  return pathIsInside(canonicalExecutable, prefix) && pathIsInside(canonicalExecutable, basePrefix);
}

async function runtimeReadPaths(canonicalExecutable, identity) {
  const paths = new Set();
  if (!await addExecutableRoots(paths, canonicalExecutable)) return null;
  if (!await addExecutableRoots(paths, identity.executable)) return null;
  if (!await addDirectoryRoots(paths, identity.prefix)) return null;
  if (!await addDirectoryRoots(paths, identity.base_prefix)) return null;
  return Array.from(paths).sort();
}

async function addExecutableRoots(paths, executable) {
  if (!await isExecutableFile(executable)) return false;
  const lexical = path.resolve(executable);
  const real = await fsp.realpath(lexical).catch(() => null);
  if (!real) return false;
  const lexicalDirectory = path.dirname(lexical);
  const realLexicalDirectory = await fsp.realpath(lexicalDirectory).catch(() => null);
  addRootAndCommandLineTools(paths, lexicalDirectory);
  if (realLexicalDirectory) addRootAndCommandLineTools(paths, realLexicalDirectory);
  addRootAndCommandLineTools(paths, path.dirname(real));
  return true;
}

async function addDirectoryRoots(paths, directory) {
  const lexical = path.resolve(directory);
  const stat = await fsp.stat(lexical).catch(() => null);
  if (!stat?.isDirectory()) return false;
  const real = await fsp.realpath(lexical).catch(() => null);
  if (!real) return false;
  addRootAndCommandLineTools(paths, lexical);
  addRootAndCommandLineTools(paths, real);
  return true;
}

async function canonicalDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) return null;
  const stat = await fsp.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) return null;
  return fsp.realpath(directory).catch(() => null);
}

function addRootAndCommandLineTools(paths, value) {
  paths.add(path.resolve(value));
  const commandLineTools = ancestorNamed(value, "CommandLineTools");
  if (commandLineTools) paths.add(commandLineTools);
}

async function includesUnsafeRoot(readPaths, env) {
  const homes = new Set();
  const configuredHome = env?.HOME ?? os.homedir();
  if (typeof configuredHome === "string" && configuredHome) {
    const lexicalHome = path.resolve(configuredHome);
    homes.add(lexicalHome);
    homes.add(await fsp.realpath(lexicalHome).catch(() => lexicalHome));
  }
  return readPaths.some((item) => {
    const resolved = path.resolve(item);
    return resolved === path.parse(resolved).root ||
      homes.has(resolved) ||
      Array.from(homes).some((home) => pathIsInside(home, resolved));
  });
}

function pythonProbeEnvironment(env) {
  return Object.fromEntries(
    PROBE_ENV_KEYS
      .filter((key) => typeof env?.[key] === "string")
      .map((key) => [key, env[key]]),
  );
}

async function isExecutableFile(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  try {
    await fsp.access(value, fsConstants.X_OK);
    return (await fsp.stat(value)).isFile();
  } catch {
    return false;
  }
}

function ancestorNamed(value, name) {
  let current = path.resolve(value);
  while (true) {
    if (path.basename(current) === name) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function probeTimeout(value) {
  if (value === undefined) return DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Runtime probe timeout must be a positive number");
  }
  return value;
}

function fallbackExecutables(value) {
  if (value === undefined) return [...DEFAULT_PYTHON_FALLBACKS];
  if (!Array.isArray(value)) {
    throw new Error("Runtime fallback candidates must be an array");
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !path.isAbsolute(item)) {
      throw new Error(`Runtime fallback candidate ${index} must be absolute`);
    }
    return path.resolve(item);
  });
}

async function normalizeForbiddenRoots(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Runtime forbidden roots must be an array");
  }
  const roots = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !path.isAbsolute(item)) {
      throw new Error(`Runtime forbidden root ${index} must be absolute`);
    }
    const lexical = path.resolve(item);
    roots.add(lexical);
    roots.add(await fsp.realpath(lexical).catch(() => lexical));
  }
  return Array.from(roots);
}

async function overlapsForbiddenRoot(candidate, forbiddenRoots) {
  if (forbiddenRoots.length === 0) return false;
  const lexical = path.resolve(candidate);
  const real = await fsp.realpath(lexical).catch(() => lexical);
  return [lexical, real].some((item) =>
    forbiddenRoots.some((root) => pathIsInside(item, root) || pathIsInside(root, item)),
  );
}

async function anyOverlapsForbiddenRoot(candidates, forbiddenRoots) {
  for (const candidate of candidates) {
    if (await overlapsForbiddenRoot(candidate, forbiddenRoots)) return true;
  }
  return false;
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

import fs from "node:fs";
import path from "node:path";

export const BIRTH_SHELL = "/bin/zsh";
const INTERNAL_ENV_PREFIX = "AGENT_HUB_INTERNAL_";
const INTERNAL_PATH_PREPEND_ENV = "AGENT_HUB_INTERNAL_PATH_PREPEND";
const INTERNAL_POST_BIRTH_ENV_PREFIX = "AGENT_HUB_INTERNAL_POST_BIRTH_";
const ALLOWED_POST_BIRTH_ENV_KEYS = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_HOME",
  "TEMP",
  "TMP",
  "TMPDIR",
]);
const DEFAULT_BIRTH_COMMAND = 'exec "$0" "$@"';
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// zsh reads ~/.zshenv before this command body. The body therefore resolves any
// PATH-based shebang interpreter first, applies private overlays after cwd-based
// namespace rebinding, removes every handoff key, and only then execs the agent.
export function buildBirthLaunch(command, baseEnv, options = {}) {
  const pathPrepend = normalizePathPrepend(options.path_prepend);
  const postBirthEnv = normalizePostBirthEnv(options.post_birth_env);
  const postBirthUnset = normalizePostBirthUnset(options.post_birth_unset);
  const hasPinnedInterpreter = options.path_interpreter !== undefined &&
    options.path_interpreter !== null;
  const inspectsExecutable = pathPrepend.length > 0 || hasPinnedInterpreter;
  if (inspectsExecutable && !path.isAbsolute(command?.command)) {
    throw new Error("Commands with a PATH overlay or pinned interpreter must use an absolute executable");
  }
  const interpreterName = inspectsExecutable
    ? pathResolvedShebangName(command.command)
    : null;
  const pathInterpreter = pinnedPathInterpreter(interpreterName, options.path_interpreter);
  const launcher = birthArgv(command, {
    pathInterpreter,
    postBirthEnvKeys: Object.keys(postBirthEnv),
    postBirthUnset,
    prependPath: pathPrepend.length > 0,
  });
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith(INTERNAL_ENV_PREFIX)) delete env[key];
  }
  for (const [index, value] of Object.values(postBirthEnv).entries()) {
    env[`${INTERNAL_POST_BIRTH_ENV_PREFIX}${index}`] = value;
  }
  if (pathPrepend.length > 0) {
    env[INTERNAL_PATH_PREPEND_ENV] = pathPrepend.join(path.delimiter);
  }
  return { env, launcher };
}

function birthArgv(
  command,
  { pathInterpreter = null, postBirthEnvKeys = [], postBirthUnset = [], prependPath = false } = {},
) {
  const steps = [];
  if (pathInterpreter) {
    steps.push(
      '__agent_hub_interpreter="$1"',
      '[[ "$__agent_hub_interpreter" = /* && -x "$__agent_hub_interpreter" ]] || exit 126',
      "shift",
    );
  }
  for (const key of postBirthUnset) {
    steps.push(`unset ${key}`);
  }
  for (const [index, key] of postBirthEnvKeys.entries()) {
    const privateKey = `${INTERNAL_POST_BIRTH_ENV_PREFIX}${index}`;
    steps.push(
      `[[ -n "\${${privateKey}+x}" ]] || exit 126`,
      `export ${key}="\${${privateKey}}"`,
      `unset ${privateKey}`,
    );
  }
  if (prependPath) {
    steps.push(
      `[[ -n "\${${INTERNAL_PATH_PREPEND_ENV}:-}" ]] || exit 126`,
      `export PATH="\${${INTERNAL_PATH_PREPEND_ENV}}\${PATH:+:\${PATH}}"`,
      `unset ${INTERNAL_PATH_PREPEND_ENV}`,
    );
  }
  steps.push(pathInterpreter
    ? 'exec "$__agent_hub_interpreter" "$0" "$@"'
    : DEFAULT_BIRTH_COMMAND);
  return [
    BIRTH_SHELL,
    "-c",
    steps.join("; "),
    command.command,
    ...(pathInterpreter ? [pathInterpreter] : []),
    ...command.args,
  ];
}

function normalizePostBirthUnset(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Post-birth unset keys must be an array");
  const seen = new Set();
  for (const [index, key] of value.entries()) {
    if (typeof key !== "string" || !ENV_NAME_PATTERN.test(key)) {
      throw new Error(`Post-birth unset key ${index} must be an environment variable name`);
    }
    seen.add(key);
  }
  return Array.from(seen).sort();
}

function normalizePathPrepend(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Birth PATH prepend must be an array");
  return value.map((item, index) => {
    if (typeof item !== "string" || !path.isAbsolute(item) || item.includes(path.delimiter)) {
      throw new Error(`Birth PATH prepend ${index} must be an absolute path without delimiters`);
    }
    return item;
  });
}

function normalizePostBirthEnv(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Post-birth environment must be an object");
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const normalized = Object.create(null);
  for (const [key, item] of entries) {
    if (!ALLOWED_POST_BIRTH_ENV_KEYS.has(key)) {
      throw new Error(`Post-birth environment contains an invalid key: ${JSON.stringify(key)}`);
    }
    if (typeof item !== "string" || item.includes("\0")) {
      throw new Error(`Post-birth environment ${key} must be a string without NUL bytes`);
    }
    normalized[key] = item;
  }
  return normalized;
}

export function pathResolvedShebangName(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(512);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead < 2 || buffer[0] !== 0x23 || buffer[1] !== 0x21) return null;
    const line = buffer.subarray(2, bytesRead).toString("utf8").split(/\r?\n/, 1)[0].trim();
    const [interpreter, ...args] = line.split(/\s+/);
    if (path.basename(interpreter) !== "env") return null;
    if (args.length !== 1 || !COMMAND_NAME_PATTERN.test(args[0])) {
      throw new Error("Command executable has an unsupported env shebang");
    }
    return args[0];
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function pinnedPathInterpreter(name, value) {
  if (!name) {
    if (value !== undefined && value !== null) {
      throw new Error("A pinned interpreter was provided for an executable without an env shebang");
    }
    return null;
  }
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`Command env shebang ${name} requires a pinned absolute interpreter`);
  }
  const normalized = path.resolve(value);
  let real;
  try {
    real = fs.realpathSync(normalized);
    if (!fs.statSync(real).isFile()) throw new Error("not a file");
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new Error(`Pinned command interpreter ${name} is unavailable`);
  }
  if (real !== normalized) {
    throw new Error(`Pinned command interpreter ${name} must be canonical`);
  }
  return real;
}

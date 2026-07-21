import { execFileSync } from "node:child_process";

const DEFAULT_AGENT_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "AGENT_HUB_CLAUDE_EFFORT",
  "AGENT_HUB_CLAUDE_MODEL",
  "AGENT_HUB_CODEX_EFFORT",
  "AGENT_HUB_CODEX_MODEL",
  "AGENT_HUB_FORWARD_ENV",
  "AGENT_HUB_KIMI_EFFORT",
  "AGENT_HUB_KIMI_MODEL",
  "AGENT_HUB_RUN_TTL_SECONDS",
  "AWS_ACCESS_KEY_ID",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COLORTERM",
  "DISABLE_AUTO_UPDATE",
  "FORCE_COLOR",
  "GH_CONFIG_DIR",
  "GIT_CONFIG_GLOBAL",
  "HOME",
  "KIMI_CODE_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "NO_COLOR",
  "NS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

const NAMESPACE_ENV_KEYS = [
  "NS",
  "GH_CONFIG_DIR",
  "GIT_CONFIG_GLOBAL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "KIMI_CODE_HOME",
];

const DIRENV_CANDIDATES = [
  "direnv",
  "/opt/homebrew/bin/direnv",
  "/usr/local/bin/direnv",
  "/usr/bin/direnv",
];
const NAMESPACE_PROBE_TIMEOUT_MS = 5000;

function clearedNamespaceEnv() {
  return Object.fromEntries(NAMESPACE_ENV_KEYS.map((key) => [key, undefined]));
}

// Namespace rule (~/work/meta/charter/NAMESPACE.md): the environment always follows
// position — derive the workspace namespace from the run's cwd via direnv, regardless
// of what the server process inherited. Stale DIRENV_* bookkeeping is stripped so the
// probe evaluates cleanly for this cwd.
export function resolveNamespaceEnv(cwd, source = process.env) {
  const probeEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith("DIRENV_")) {
      probeEnv[key] = value;
    }
  }
  for (const key of NAMESPACE_ENV_KEYS) {
    delete probeEnv[key];
  }
  probeEnv.DIRENV_LOG_FORMAT = "";
  const candidates = source.AGENT_HUB_DIRENV_BIN
    ? [source.AGENT_HUB_DIRENV_BIN]
    : DIRENV_CANDIDATES;
  for (const bin of candidates) {
    let stdout;
    try {
      stdout = execFileSync(bin, ["export", "json"], {
        cwd,
        env: probeEnv,
        timeout: NAMESPACE_PROBE_TIMEOUT_MS,
        encoding: "utf8",
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      return clearedNamespaceEnv();
    }
    if (!stdout || !stdout.trim()) {
      return clearedNamespaceEnv();
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return clearedNamespaceEnv();
    }
    const env = clearedNamespaceEnv();
    for (const key of NAMESPACE_ENV_KEYS) {
      if (typeof parsed[key] === "string") {
        env[key] = parsed[key];
      } else if (Object.hasOwn(parsed, key) && parsed[key] === null) {
        // direnv uses null to unset a variable inherited from another namespace.
        // child_process omits undefined env values, so the overlay clears it.
        env[key] = undefined;
      }
    }
    return env;
  }
  return clearedNamespaceEnv();
}

export function buildAgentEnv(source = process.env) {
  const env = {};
  for (const key of DEFAULT_AGENT_ENV_KEYS) {
    if (typeof source[key] === "string") {
      env[key] = source[key];
    }
  }

  for (const key of forwardedEnvKeys(source.AGENT_HUB_FORWARD_ENV)) {
    if (typeof source[key] === "string") {
      env[key] = source[key];
    }
  }
  return env;
}

export function forwardedEnvKeys(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

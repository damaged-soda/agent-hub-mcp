const DEFAULT_AGENT_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "AGENT_HUB_FORWARD_ENV",
  "AGENT_HUB_RUN_TTL_SECONDS",
  "AWS_ACCESS_KEY_ID",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "COLORTERM",
  "DISABLE_AUTO_UPDATE",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "NO_COLOR",
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

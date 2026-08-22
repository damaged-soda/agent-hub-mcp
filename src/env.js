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
  "BASH_ENV",
  "AWS_ACCESS_KEY_ID",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
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
  "NS_UNDO",
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

// Namespace：agent-hub 不解析、不推导、不清洗——调用方环境原样透传（白名单内）。
// charter 会话轴的语义是「绑定只在 shell 出生那一刻由 glue 做，进程只继承」：agent CLI
// 进程继承调用方的 NS / NS_UNDO / PATH，它起的每个工具 shell 出生时自己跑 ns-resolve
// 按 cwd 做状态转换。这里再做一遍就是第二个求值器（direnv 时代的遗留，2026-08-22 拆除）。

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

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
  "AGENT_HUB_OPENCODE_EFFORT",
  "AGENT_HUB_OPENCODE_MODEL",
  "AGENT_HUB_REVIEW_DEPTH",
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
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
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

// Namespace：agent-hub 不解析、不推导、不清洗。会话轴状态（NS / NS_UNDO / PATH /
// GH_CONFIG_DIR / BASH_ENV）**整体**转发，runner 置 NS_REBIND=1 并经 zsh 把 agent 起在
// run 的 cwd：~/.zshenv 的 glue（charter ns-resolve）先按 NS_UNDO 卸掉继承的域（同域也
// 卸——补齐白名单过滤掉的域变量），再按 cwd 绑定，无域则只卸。整体继承、整体转换
//（charter E7：选择性清洗致静默残缺）。direnv 时代 hub 自己推导环境的逻辑 2026-08-22 拆除。

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

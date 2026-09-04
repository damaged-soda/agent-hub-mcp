import fs from "node:fs";
import path from "node:path";

export const CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY = "AGENT_HUB_CLAUDE_OAUTH_TOKEN_FILE";
export const CLAUDE_OAUTH_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_CREDENTIAL_ENV_KEYS = Object.freeze([
  CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY,
]);

const MAX_TOKEN_FILE_BYTES = 4096;
const CLAUDE_AUTH_ENV_KEYS = Object.freeze([
  CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY,
  CLAUDE_OAUTH_TOKEN_ENV_KEY,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

export function prepareClaudeLaunchEnvironment({ env = process.env } = {}) {
  const token = readClaudeOAuthToken(env);
  if (token === null) return null;
  return {
    remove_env_keys: [...CLAUDE_AUTH_ENV_KEYS],
    post_birth_env: {
      [CLAUDE_OAUTH_TOKEN_ENV_KEY]: token,
    },
  };
}

export function readClaudeOAuthToken(env = process.env) {
  const configuredPath = env[CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY];
  if (configuredPath === undefined) return null;
  if (
    typeof configuredPath !== "string" ||
    configuredPath.length === 0 ||
    configuredPath !== configuredPath.trim() ||
    configuredPath.includes("\0") ||
    !path.isAbsolute(configuredPath)
  ) {
    throw invalidTokenFile("must be configured with an absolute path");
  }

  const normalizedPath = path.resolve(configuredPath);
  let realPath;
  try {
    realPath = fs.realpathSync(normalizedPath);
  } catch {
    throw invalidTokenFile("is not readable");
  }
  if (realPath !== normalizedPath) {
    throw invalidTokenFile("must not contain symbolic links");
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(normalizedPath, fs.constants.O_RDONLY | noFollow);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw invalidTokenFile("must be a regular file");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw invalidTokenFile("must be owned by the current user");
    }
    if ((metadata.mode & 0o7777) !== 0o600) {
      throw invalidTokenFile("must have mode 0600");
    }
    if (metadata.size < 1 || metadata.size > MAX_TOKEN_FILE_BYTES) {
      throw invalidTokenFile("must contain between 1 and 4096 bytes");
    }
    return decodeToken(readBounded(descriptor));
  } catch (error) {
    if (error?.code === "claude_oauth_token_file_invalid") throw error;
    throw invalidTokenFile("could not be read safely");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readBounded(descriptor) {
  const buffer = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_TOKEN_FILE_BYTES) {
    throw invalidTokenFile("must contain between 1 and 4096 bytes");
  }
  return buffer.subarray(0, offset);
}

function decodeToken(buffer) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw invalidTokenFile("must be UTF-8 text");
  }
  if (text.endsWith("\r\n")) {
    text = text.slice(0, -2);
  } else if (text.endsWith("\n")) {
    text = text.slice(0, -1);
  }
  if (!text || text.includes("\0") || /\s/u.test(text)) {
    throw invalidTokenFile("must contain one non-empty token line");
  }
  return text;
}

function invalidTokenFile(reason) {
  const error = new Error(`Claude OAuth token file ${reason}`);
  error.code = "claude_oauth_token_file_invalid";
  error.retryable = false;
  return error;
}

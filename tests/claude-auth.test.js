import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY,
  prepareClaudeLaunchEnvironment,
  readClaudeOAuthToken,
} from "../src/claude-auth.js";

describe("Claude setup-token file", () => {
  let root;
  let tokenPath;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-claude-auth-test-"));
    root = await fsp.realpath(root);
    tokenPath = path.join(root, "setup-token");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("is opt-in and reads a private single-line token on every launch", async () => {
    expect(readClaudeOAuthToken({})).toBeNull();
    await writeToken(tokenPath, "first-token\n");
    const env = { [CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY]: tokenPath };
    expect(readClaudeOAuthToken(env)).toBe("first-token");

    await writeToken(tokenPath, "rotated-token\r\n");
    expect(readClaudeOAuthToken(env)).toBe("rotated-token");
  });

  it("builds a Claude-only post-birth overlay and removes competing auth", async () => {
    await writeToken(tokenPath, "oauth-token");
    const prepared = prepareClaudeLaunchEnvironment({
      env: { [CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY]: tokenPath },
    });

    expect(prepared.post_birth_env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" });
    expect(prepared.remove_env_keys).toEqual(expect.arrayContaining([
      "AGENT_HUB_CLAUDE_OAUTH_TOKEN_FILE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]));
  });

  it.each([
    ["relative path", "relative-token", null],
    ["blank path", " ", null],
    ["empty file", null, ""],
    ["multiple lines", null, "one\ntwo\n"],
    ["embedded whitespace", null, "one two"],
    ["NUL byte", null, "one\0two"],
  ])("rejects %s without exposing file contents", async (_label, configured, contents) => {
    if (contents !== null) await writeToken(tokenPath, contents);
    const value = configured ?? tokenPath;
    expectInvalid(() => readClaudeOAuthToken({
      [CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY]: value,
    }), contents);
  });

  it("rejects a symlink, a directory, loose permissions, invalid UTF-8, and oversized input", async () => {
    const target = path.join(root, "target-token");
    await writeToken(target, "symlink-secret");
    await fsp.symlink(target, tokenPath);
    expectInvalid(() => readClaudeOAuthToken({
      [CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY]: tokenPath,
    }), "symlink-secret");

    expectInvalid(() => readClaudeOAuthToken({
      [CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY]: root,
    }));

    const loose = path.join(root, "loose-token");
    await writeToken(loose, "loose-secret", 0o644);
    expectInvalid(() => readClaudeOAuthToken({
      [CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY]: loose,
    }), "loose-secret");

    const invalidUtf8 = path.join(root, "invalid-utf8");
    await fsp.writeFile(invalidUtf8, Buffer.from([0xff]), { mode: 0o600 });
    await fsp.chmod(invalidUtf8, 0o600);
    expectInvalid(() => readClaudeOAuthToken({
      [CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY]: invalidUtf8,
    }));

    const oversized = path.join(root, "oversized-token");
    await writeToken(oversized, "x".repeat(4097));
    expectInvalid(() => readClaudeOAuthToken({
      [CLAUDE_OAUTH_TOKEN_FILE_ENV_KEY]: oversized,
    }));
  });
});

async function writeToken(file, contents, mode = 0o600) {
  await fsp.writeFile(file, contents, { mode });
  await fsp.chmod(file, mode);
}

function expectInvalid(action, secret = null) {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "claude_oauth_token_file_invalid", retryable: false });
  if (secret) expect(caught.message).not.toContain(secret);
}

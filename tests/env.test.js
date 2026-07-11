import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAgentEnv, resolveNamespaceEnv } from "../src/env.js";
import { currentEnvKeys } from "../src/fs-store.js";

describe("agent environment", () => {
  it("forwards Claude API auth while keeping command metadata secret-free", () => {
    const env = buildAgentEnv({
      PATH: "/bin",
      HOME: "/tmp/home",
      ANTHROPIC_API_KEY: "secret",
      GITHUB_TOKEN: "not-forwarded",
    });

    expect(env.ANTHROPIC_API_KEY).toBe("secret");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(currentEnvKeys(env)).not.toContain("ANTHROPIC_API_KEY");
  });

  it("forwards Codex auth and default-model vars", () => {
    const env = buildAgentEnv({
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      AGENT_HUB_CODEX_MODEL: "gpt-5.2-codex",
    });

    expect(env.OPENAI_API_KEY).toBe("secret");
    expect(env.OPENAI_BASE_URL).toBe("https://example.invalid/v1");
    expect(env.AGENT_HUB_CODEX_MODEL).toBe("gpt-5.2-codex");
    expect(currentEnvKeys(env)).not.toContain("OPENAI_API_KEY");
  });

  it("forwards server-side default effort vars", () => {
    const env = buildAgentEnv({
      PATH: "/bin",
      AGENT_HUB_CLAUDE_EFFORT: "high",
      AGENT_HUB_CODEX_EFFORT: "xhigh",
    });

    expect(env.AGENT_HUB_CLAUDE_EFFORT).toBe("high");
    expect(env.AGENT_HUB_CODEX_EFFORT).toBe("xhigh");
  });

  it("forwards namespace redirect vars when present in the server env", () => {
    const env = buildAgentEnv({
      PATH: "/bin",
      NS: "personal",
      GH_CONFIG_DIR: "/home/u/ns/personal/github/runtime",
      GIT_CONFIG_GLOBAL: "/home/u/ns/personal/github/config/gitconfig",
      CLAUDE_CONFIG_DIR: "/home/u/ns/personal/claude",
      CODEX_HOME: "/home/u/ns/personal/codex",
    });

    expect(env.NS).toBe("personal");
    expect(env.GH_CONFIG_DIR).toBe("/home/u/ns/personal/github/runtime");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/home/u/ns/personal/github/config/gitconfig");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/ns/personal/claude");
    expect(env.CODEX_HOME).toBe("/home/u/ns/personal/codex");
  });
});

describe("namespace resolution from run cwd", () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-direnv-"));
  const stubBin = path.join(stubDir, "direnv-stub");
  const unsetStubBin = path.join(stubDir, "direnv-unset-stub");
  fs.writeFileSync(
    stubBin,
    `#!/bin/sh
echo '{"NS":"personal","GH_CONFIG_DIR":"/home/u/ns/personal/github/runtime","GIT_CONFIG_GLOBAL":"/home/u/ns/personal/github/config/gitconfig","DIRENV_DIFF":"bookkeeping","OTHER":"junk"}'
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    unsetStubBin,
    `#!/bin/sh
echo '{"NS":null,"GH_CONFIG_DIR":null,"GIT_CONFIG_GLOBAL":null,"CLAUDE_CONFIG_DIR":null,"CODEX_HOME":"/home/u/.codex"}'
`,
    { mode: 0o755 },
  );

  afterAll(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it("derives from cwd even when the server env carries another namespace", () => {
    const env = resolveNamespaceEnv(stubDir, {
      NS: "company",
      GH_CONFIG_DIR: "/home/u/ns/company/github/runtime",
      GIT_CONFIG_GLOBAL: "/home/u/ns/company/github/config/gitconfig",
      AGENT_HUB_DIRENV_BIN: stubBin,
    });
    expect(env).toEqual({
      NS: "personal",
      GH_CONFIG_DIR: "/home/u/ns/personal/github/runtime",
      GIT_CONFIG_GLOBAL: "/home/u/ns/personal/github/config/gitconfig",
    });
  });

  it("derives namespace keys and drops direnv bookkeeping", () => {
    const env = resolveNamespaceEnv(stubDir, {
      PATH: "/bin",
      DIRENV_DIFF: "stale-inherited-state",
      AGENT_HUB_DIRENV_BIN: stubBin,
    });
    expect(env).toEqual({
      NS: "personal",
      GH_CONFIG_DIR: "/home/u/ns/personal/github/runtime",
      GIT_CONFIG_GLOBAL: "/home/u/ns/personal/github/config/gitconfig",
    });
  });

  it("clears namespace keys that direnv returns as null", () => {
    const env = resolveNamespaceEnv(stubDir, {
      NS: "personal",
      GH_CONFIG_DIR: "/home/u/ns/personal/github/runtime",
      GIT_CONFIG_GLOBAL: "/home/u/ns/personal/github/config/gitconfig",
      CLAUDE_CONFIG_DIR: "/home/u/ns/personal/claude",
      CODEX_HOME: "/home/u/ns/personal/codex",
      AGENT_HUB_DIRENV_BIN: unsetStubBin,
    });
    expect(env).toEqual({
      NS: undefined,
      GH_CONFIG_DIR: undefined,
      GIT_CONFIG_GLOBAL: undefined,
      CLAUDE_CONFIG_DIR: undefined,
      CODEX_HOME: "/home/u/.codex",
    });
  });

  it("returns empty when direnv is unavailable", () => {
    const env = resolveNamespaceEnv(stubDir, {
      PATH: "/bin",
      AGENT_HUB_DIRENV_BIN: path.join(stubDir, "missing-binary"),
    });
    expect(env).toEqual({});
  });
});

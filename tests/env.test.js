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

  it("forwards namespace redirect vars when present in the server env", () => {
    const env = buildAgentEnv({
      PATH: "/bin",
      NS: "personal",
      GH_CONFIG_DIR: "/home/u/ns/personal/gh",
      CLAUDE_CONFIG_DIR: "/home/u/ns/personal/claude",
      CODEX_HOME: "/home/u/ns/personal/codex",
    });

    expect(env.NS).toBe("personal");
    expect(env.GH_CONFIG_DIR).toBe("/home/u/ns/personal/gh");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/ns/personal/claude");
    expect(env.CODEX_HOME).toBe("/home/u/ns/personal/codex");
  });
});

describe("namespace resolution from run cwd", () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-direnv-"));
  const stubBin = path.join(stubDir, "direnv-stub");
  fs.writeFileSync(
    stubBin,
    `#!/bin/sh
echo '{"NS":"personal","GH_CONFIG_DIR":"/home/u/ns/personal/gh","DIRENV_DIFF":"bookkeeping","OTHER":"junk"}'
`,
    { mode: 0o755 },
  );

  afterAll(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it("derives from cwd even when the server env carries another namespace", () => {
    const env = resolveNamespaceEnv(stubDir, {
      NS: "company",
      GH_CONFIG_DIR: "/home/u/ns/company/gh",
      AGENT_HUB_DIRENV_BIN: stubBin,
    });
    expect(env).toEqual({
      NS: "personal",
      GH_CONFIG_DIR: "/home/u/ns/personal/gh",
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
      GH_CONFIG_DIR: "/home/u/ns/personal/gh",
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

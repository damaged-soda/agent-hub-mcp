import { describe, expect, it } from "vitest";
import { buildAgentEnv } from "../src/env.js";
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
      AGENT_HUB_KIMI_EFFORT: "medium",
      AGENT_HUB_KIMI_MODEL: "k2",
    });

    expect(env.AGENT_HUB_CLAUDE_EFFORT).toBe("high");
    expect(env.AGENT_HUB_CODEX_EFFORT).toBe("xhigh");
    expect(env.AGENT_HUB_KIMI_EFFORT).toBe("medium");
    expect(env.AGENT_HUB_KIMI_MODEL).toBe("k2");
  });

  it("omits namespace keys that were explicitly cleared from command metadata", () => {
    expect(currentEnvKeys({ PATH: "/bin", NS: undefined, CLAUDE_CONFIG_DIR: undefined })).toEqual([
      "PATH",
    ]);
  });

  it("forwards namespace redirect vars when present in the server env", () => {
    const env = buildAgentEnv({
      PATH: "/bin",
      NS: "personal",
      GH_CONFIG_DIR: "/home/u/ns/personal/github/runtime",
      GIT_CONFIG_GLOBAL: "/home/u/ns/personal/github/config/gitconfig",
      CLAUDE_CONFIG_DIR: "/home/u/ns/personal/claude",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/u/.local/state/claude-code-secure-storage",
      CODEX_HOME: "/home/u/ns/personal/codex",
      KIMI_CODE_HOME: "/home/u/ns/personal/kimi",
      BASH_ENV: "/home/u/work/meta/charter/glue/ns-birth.bash",
    });

    expect(env.BASH_ENV).toBe("/home/u/work/meta/charter/glue/ns-birth.bash");
    expect(env.NS).toBe("personal");
    expect(env.GH_CONFIG_DIR).toBe("/home/u/ns/personal/github/runtime");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/home/u/ns/personal/github/config/gitconfig");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/ns/personal/claude");
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
      "/home/u/.local/state/claude-code-secure-storage",
    );
    expect(env.CODEX_HOME).toBe("/home/u/ns/personal/codex");

    expect(env.KIMI_CODE_HOME).toBe("/home/u/ns/personal/kimi");
  });

  it("forwards the session-axis bookkeeping verbatim so the agent's tool shells can switch domains", () => {
    // charter：NS + NS_UNDO 是 ns-resolve 做跨域转换的全部输入；agent-hub 只搬运，不解析
    const env = buildAgentEnv({
      PATH: "/home/u/ns/meta/bin:/usr/bin",
      NS: "meta",
      NS_UNDO: "unset NS;__ns_path_strip lit '/home/u/ns/meta/bin'",
      BASH_ENV: "/home/u/ns/.charter/glue/ns-birth.bash",
    });
    expect(env.NS).toBe("meta");
    expect(env.NS_UNDO).toBe("unset NS;__ns_path_strip lit '/home/u/ns/meta/bin'");
    expect(env.PATH).toBe("/home/u/ns/meta/bin:/usr/bin");
    expect(env.BASH_ENV).toBe("/home/u/ns/.charter/glue/ns-birth.bash");
  });
});

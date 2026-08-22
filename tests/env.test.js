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

  it("forwards the session-axis state whole (NS / NS_UNDO / PATH / GH_CONFIG_DIR / BASH_ENV): glue rebinds it at the run cwd", () => {
    const env = buildAgentEnv({
      PATH: "/home/u/ns/meta/bin:/usr/bin",
      NS: "meta",
      NS_UNDO: "unset NS",
      GH_CONFIG_DIR: "/home/u/ns/base/github/accounts/acct",
      BASH_ENV: "/home/u/ns/.charter/glue/ns-birth.bash",
      FEISHU_OWNER_EMAIL: "material-var-not-in-allowlist",
    });
    expect(env.NS).toBe("meta");
    expect(env.NS_UNDO).toBe("unset NS");
    expect(env.PATH).toBe("/home/u/ns/meta/bin:/usr/bin");
    expect(env.GH_CONFIG_DIR).toBe("/home/u/ns/base/github/accounts/acct");
    expect(env.BASH_ENV).toBe("/home/u/ns/.charter/glue/ns-birth.bash");
    // 白名单外的域变量不透传——正因如此 runner 必须置 NS_REBIND=1 让 glue 在 cwd 重求值补齐
    expect(env).not.toHaveProperty("FEISHU_OWNER_EMAIL");
  });
});

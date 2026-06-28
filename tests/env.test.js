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
});

import { describe, expect, it } from "vitest";
import { buildBirthLaunch } from "../src/birth-command.js";

describe("birth command", () => {
  it("allows a relative executable for a post-birth-only secret handoff", () => {
    const birth = buildBirthLaunch(
      { command: "claude", args: ["-p"] },
      { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "stale" },
      {
        post_birth_unset: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        post_birth_env: { CLAUDE_CODE_OAUTH_TOKEN: "fresh" },
      },
    );

    expect(birth.launcher[0]).toBe("/bin/zsh");
    expect(birth.launcher.slice(-2)).toEqual(["claude", "-p"]);
    expect(birth.launcher[2]).toContain("unset ANTHROPIC_API_KEY");
    expect(birth.launcher[2]).toContain("unset CLAUDE_CODE_OAUTH_TOKEN");
    expect(birth.launcher[2]).toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
    expect(birth.launcher[2]).not.toContain("fresh");
    expect(Object.values(birth.env)).toContain("fresh");
  });

  it("rejects unsafe post-birth unset names", () => {
    expect(() => buildBirthLaunch(
      { command: "claude", args: [] },
      {},
      { post_birth_unset: ["SAFE; touch /tmp/nope"] },
    )).toThrow("must be an environment variable name");
  });
});

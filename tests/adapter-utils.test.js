import { describe, expect, it } from "vitest";
import { runVersionCommand } from "../src/adapter-utils.js";

describe("runVersionCommand", () => {
  it("returns the spawn error instead of throwing when the binary is missing", async () => {
    const result = await runVersionCommand("agent-hub-definitely-missing-binary", ["--version"], 5000);
    expect(result.code).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toMatch(/ENOENT/);
  });
});

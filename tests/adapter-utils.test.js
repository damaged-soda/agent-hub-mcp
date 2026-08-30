import { describe, expect, it } from "vitest";
import { runCommand, runVersionCommand } from "../src/adapter-utils.js";

describe("runVersionCommand", () => {
  it("returns the spawn error instead of throwing when the binary is missing", async () => {
    const result = await runVersionCommand("agent-hub-definitely-missing-binary", ["--version"], 5000);
    expect(result.code).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toMatch(/ENOENT/);
  });
});

describe("runCommand", () => {
  it("drains discarded output without applying the capture limit", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      { captureOutput: false, maxOutputBytes: 1, timeoutMs: 5000 },
    );
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(result.error).toBeUndefined();
  });
});

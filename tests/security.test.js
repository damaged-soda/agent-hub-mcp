import { describe, expect, it } from "vitest";
import { validateRequestPaths } from "../src/security.js";

describe("request path validation", () => {
  it("rejects relative cwd values", async () => {
    await expect(validateRequestPaths(".", {})).rejects.toThrow(/cwd must be an absolute path/);
  });

  it("validates add_dirs under the adapter metadata key", async () => {
    await expect(
      validateRequestPaths(
        process.cwd(),
        { codex: { add_dirs: "not-an-array" } },
        { metadataKey: "codex" },
      ),
    ).rejects.toThrow(/metadata.codex.add_dirs must be an array/);
  });

  it("falls back to unified top-level add_dirs", async () => {
    const resolved = await validateRequestPaths(
      process.cwd(),
      { add_dirs: ["."] },
      { metadataKey: "codex" },
    );
    expect(resolved.addDirs).toHaveLength(1);

    await expect(
      validateRequestPaths(process.cwd(), { add_dirs: "not-an-array" }, { metadataKey: "codex" }),
    ).rejects.toThrow(/metadata.add_dirs must be an array/);
  });
});

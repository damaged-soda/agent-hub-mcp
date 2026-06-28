import { describe, expect, it } from "vitest";
import { validateRequestPaths } from "../src/security.js";

describe("request path validation", () => {
  it("rejects relative cwd values", async () => {
    await expect(validateRequestPaths(".", {})).rejects.toThrow(/cwd must be an absolute path/);
  });
});

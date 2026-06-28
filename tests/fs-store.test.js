import { describe, expect, it } from "vitest";
import { assertSafeRunId } from "../src/fs-store.js";

describe("fs store", () => {
  it("rejects run ids that could traverse out of the run root", () => {
    expect(() => assertSafeRunId("..")).toThrow(/Invalid run_id/);
    expect(() => assertSafeRunId(".hidden")).toThrow(/Invalid run_id/);
    expect(() => assertSafeRunId("safe-run_123")).not.toThrow();
  });
});

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSessionLease,
  claimSessionLineage,
  completeSessionRun,
  getSessionRecord,
  SESSION_RESERVATION_STALE_MS,
} from "../src/session-registry.js";

describe("session registry", () => {
  let root;
  let previous;
  const ref = { agent_id: "claude-code", native_session_id: "session-one" };

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "session-registry-"));
    previous = process.env.AGENT_HUB_RUN_DIR;
    process.env.AGENT_HUB_RUN_DIR = root;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (previous === undefined) delete process.env.AGENT_HUB_RUN_DIR;
    else process.env.AGENT_HUB_RUN_DIR = previous;
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("provides linear generation, lineage claims, and an exclusive active lease", async () => {
    const claimed = await claimSessionLineage(ref, {
      claim_id: "child-one",
      expected_generation: 0,
    });
    expect(claimed.generation).toBe(1);
    expect((await claimSessionLineage(ref, {
      claim_id: "child-one",
      expected_generation: 0,
    })).generation).toBe(1);
    await expect(
      claimSessionLineage(ref, { claim_id: "sibling", expected_generation: 0 }),
    ).rejects.toMatchObject({ code: "session_generation_conflict" });

    const active = await acquireSessionLease(ref, {
      run_id: "run-one",
      claim_id: "child-one",
      expected_generation: 1,
    });
    expect(active).toMatchObject({ generation: 2, active_run_id: "run-one", reserved_by: null });
    await expect(
      acquireSessionLease(ref, { run_id: "run-two", expected_generation: 2 }),
    ).rejects.toMatchObject({ code: "session_busy" });

    await completeSessionRun(ref, "run-one");
    const next = await acquireSessionLease(ref, {
      run_id: "run-two",
      expected_generation: 2,
    });
    expect(next.generation).toBe(3);
    expect((await getSessionRecord(ref)).latest_run_id).toBe("run-one");
  });

  it("expires an abandoned lineage reservation without rolling back generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const claimed = await claimSessionLineage(ref, {
      claim_id: "abandoned-child",
      expected_generation: 0,
    });
    expect(claimed).toMatchObject({ generation: 1, reserved_by: "abandoned-child" });

    vi.setSystemTime(new Date(Date.now() + SESSION_RESERVATION_STALE_MS));
    const acquired = await acquireSessionLease(ref, {
      run_id: "recovery-run",
      expected_generation: 1,
    });
    expect(acquired).toMatchObject({
      generation: 2,
      active_run_id: "recovery-run",
      reserved_by: null,
    });
  });
});

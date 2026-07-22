import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDiscussionLease,
  appendDiscussionEvent,
  createDiscussionRecord,
  discussionDirFor,
  discussionLeaseIsLive,
  readDiscussionEvents,
  readDiscussionState,
  recoverDiscussionRecord,
  releaseDiscussionLease,
} from "../src/discussion-store.js";

describe("discussion store", () => {
  let root;
  let previous;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "discussion-store-"));
    previous = process.env.AGENT_HUB_DISCUSSION_DIR;
    process.env.AGENT_HUB_DISCUSSION_DIR = root;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.AGENT_HUB_DISCUSSION_DIR;
    else process.env.AGENT_HUB_DISCUSSION_DIR = previous;
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("commits events before projections and recovers a torn tail", async () => {
    await createDiscussionRecord(baseState("discussion-one"), { kind: "new" });
    const lease = await acquireDiscussionLease("discussion-one", "owner-one");
    await appendDiscussionEvent(
      "discussion-one",
      "phase.started",
      { phase: "independent" },
      (state) => ({ ...state, phase: "independent" }),
      { lease },
    );
    const eventPath = path.join(discussionDirFor("discussion-one"), "events.jsonl");
    await fsp.appendFile(eventPath, '{"sequence":3');
    const statePath = path.join(discussionDirFor("discussion-one"), "state.json");
    const corruptedProjection = JSON.parse(await fsp.readFile(statePath, "utf8"));
    corruptedProjection.phase = "wrong-with-same-sequence";
    await fsp.writeFile(statePath, JSON.stringify(corruptedProjection));

    const recovered = await recoverDiscussionRecord("discussion-one");
    expect(recovered.phase).toBe("independent");
    expect(recovered.committed_event_sequence).toBe(3);
    const { events } = await readDiscussionEvents("discussion-one");
    expect(events.map((event) => event.type)).toEqual([
      "discussion.created",
      "phase.started",
      "discussion.recovered",
    ]);
    await releaseDiscussionLease("discussion-one", lease);
  });

  it("rejects writes from a stale lease generation", async () => {
    await createDiscussionRecord(baseState("discussion-two"), { kind: "new" });
    const lease = await acquireDiscussionLease("discussion-two", "owner-one");
    await expect(
      appendDiscussionEvent(
        "discussion-two",
        "phase.started",
        {},
        (state) => state,
        { lease: { ...lease, generation: lease.generation + 1 } },
      ),
    ).rejects.toMatchObject({ code: "discussion_lease_lost" });
    expect((await readDiscussionState("discussion-two")).committed_event_sequence).toBe(1);
    await releaseDiscussionLease("discussion-two", lease);
  });

  it("reports whether the lease owner process is still live", async () => {
    await createDiscussionRecord(baseState("discussion-three"), { kind: "new" });
    const lease = await acquireDiscussionLease("discussion-three", "owner-one");
    expect(await discussionLeaseIsLive("discussion-three")).toBe(true);
    await releaseDiscussionLease("discussion-three", lease);
    expect(await discussionLeaseIsLive("discussion-three")).toBe(false);
  });
});

function baseState(id) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    discussion_id: id,
    status: "queued",
    phase: "preparing",
    created_at: now,
    updated_at: now,
  };
}

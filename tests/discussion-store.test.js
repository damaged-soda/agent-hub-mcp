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
  withDiscussionLock,
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

  it("reclaims an ownerless filesystem lock only after the stale window", async () => {
    await createDiscussionRecord(baseState("discussion-four"), { kind: "new" });
    const lockDir = path.join(discussionDirFor("discussion-four"), ".discussion.lock");
    await fsp.mkdir(lockDir, { mode: 0o700 });
    const staleAt = new Date(Date.now() - 21_000);
    await fsp.utimes(lockDir, staleAt, staleAt);

    const lease = await acquireDiscussionLease("discussion-four", "owner-two");
    expect(lease.owner_id).toBe("owner-two");
    await releaseDiscussionLease("discussion-four", lease);
  });

  it("reclaims locks and leases when the owner pid was reused", async () => {
    await createDiscussionRecord(baseState("discussion-five"), { kind: "new" });
    const dir = discussionDirFor("discussion-five");
    const lockDir = path.join(dir, ".discussion.lock");
    await fsp.mkdir(lockDir, { mode: 0o700 });
    await fsp.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
      pid: process.pid,
      nonce: "previous-lock",
      created_at: new Date().toISOString(),
    }));

    const recovered = await recoverDiscussionRecord("discussion-five");
    expect(recovered.status).toBe("queued");

    await fsp.writeFile(path.join(dir, "lease.json"), JSON.stringify({
      schema_version: 1,
      owner_id: "previous-owner",
      pid: process.pid,
      generation: 1,
      heartbeat_at: new Date().toISOString(),
    }));
    const lease = await acquireDiscussionLease("discussion-five", "replacement-owner");
    expect(lease).toMatchObject({
      owner_id: "replacement-owner",
      generation: 2,
      pid: process.pid,
    });
    expect(lease.process_instance_id).not.toBe("previous-process-instance");
    await releaseDiscussionLease("discussion-five", lease);
  });

  it("does not reclaim a fresh lease held by another live process", async () => {
    await createDiscussionRecord(baseState("discussion-six"), { kind: "new" });
    const leasePath = path.join(discussionDirFor("discussion-six"), "lease.json");
    await fsp.writeFile(leasePath, JSON.stringify({
      schema_version: 1,
      owner_id: "external-owner",
      pid: process.ppid,
      process_instance_id: "external-process-instance",
      generation: 1,
      heartbeat_at: new Date().toISOString(),
    }));

    await expect(
      acquireDiscussionLease("discussion-six", "replacement-owner"),
    ).rejects.toMatchObject({ code: "discussion_lease_held" });
  });

  it("does not remove a lock that was replaced before release", async () => {
    await createDiscussionRecord(baseState("discussion-seven"), { kind: "new" });
    const lockDir = path.join(discussionDirFor("discussion-seven"), ".discussion.lock");
    await withDiscussionLock("discussion-seven", async () => {
      const ownerPath = path.join(lockDir, "owner.json");
      const owner = JSON.parse(await fsp.readFile(ownerPath, "utf8"));
      await fsp.writeFile(ownerPath, JSON.stringify({
        ...owner,
        nonce: "replacement-lock",
      }));
    });

    await expect(fsp.access(lockDir)).resolves.toBeUndefined();
  });

  it("reclaims an ownerless lock after the owner write grace", async () => {
    await createDiscussionRecord(baseState("discussion-eight"), { kind: "new" });
    const lockDir = path.join(discussionDirFor("discussion-eight"), ".discussion.lock");
    await fsp.mkdir(lockDir, { mode: 0o700 });
    const staleAt = new Date(Date.now() - 1100);
    await fsp.utimes(lockDir, staleAt, staleAt);

    const lease = await acquireDiscussionLease("discussion-eight", "replacement-owner");
    expect(lease.owner_id).toBe("replacement-owner");
    await releaseDiscussionLease("discussion-eight", lease);
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

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiscussionManager } from "../src/discussion-manager.js";
import { discussionDirFor, readDiscussionState } from "../src/discussion-store.js";

describe("discussion manager lifecycle", () => {
  let root;
  let workspace;
  let previousEnv;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "discussion-manager-"));
    workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(bin, { recursive: true });
    await fsp.writeFile(
      path.join(bin, "claude"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.193 (Claude Code)"; fi\n',
      { mode: 0o755 },
    );
    previousEnv = {
      PATH: process.env.PATH,
      AGENT_HUB_RUN_DIR: process.env.AGENT_HUB_RUN_DIR,
      AGENT_HUB_DISCUSSION_DIR: process.env.AGENT_HUB_DISCUSSION_DIR,
      AGENT_HUB_CWD_ALLOWLIST: process.env.AGENT_HUB_CWD_ALLOWLIST,
    };
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.AGENT_HUB_RUN_DIR = path.join(root, "runs");
    process.env.AGENT_HUB_DISCUSSION_DIR = path.join(root, "discussions");
    process.env.AGENT_HUB_CWD_ALLOWLIST = workspace;
  });

  afterEach(async () => {
    restoreEnv(previousEnv);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("cancels every active run and never starts the host after cancellation", async () => {
    const fake = createFakeRunApi({ hold: true });
    const manager = createManager(fake.api);
    await manager.start();
    const accepted = await manager.dispatch(newRequest(workspace));
    await waitUntil(async () => (await readDiscussionState(accepted.discussion_ref.discussion_id)).active_run_refs.length === 2);

    await manager.cancel({
      discussion_ref: accepted.discussion_ref,
      reason: "stop",
      actor: "test",
    });
    const terminal = await manager.wait({ discussion_ref: accepted.discussion_ref });

    expect(terminal.status).toBe("cancelled");
    expect(fake.dispatched).toHaveLength(2);
    expect(fake.cancelled.size).toBe(2);
    await manager.shutdown();
  });

  it("shutdown leaves detached runs alive and a new manager resumes them", async () => {
    const fake = createFakeRunApi({ hold: true });
    const first = createManager(fake.api);
    await first.start();
    const accepted = await first.dispatch(newRequest(workspace));
    const id = accepted.discussion_ref.discussion_id;
    await waitUntil(async () => (await readDiscussionState(id)).active_run_refs.length === 2);

    await first.shutdown();
    expect(fake.cancelled.size).toBe(0);
    expect((await readDiscussionState(id)).status).toBe("running");

    fake.completeAll();
    fake.hold = false;
    const second = createManager(fake.api);
    await second.start();
    const terminal = await second.wait({ discussion_ref: accepted.discussion_ref });

    expect(terminal.status).toBe("completed");
    expect(terminal.protocol_integrity).toBe("complete");
    expect(terminal.completion_quality).toBe("complete");
    expect(terminal.failure_summary).toBeNull();
    expect(terminal.phase_statistics.find((item) => item.phase === "synthesizing")).toMatchObject({
      required: 1,
      accepted: 1,
      failed: 0,
    });
    expect(terminal.run_refs).toHaveLength(8);
    await second.shutdown();
  });

  it("rebuilds follow-up participants from a member-scoped handoff", async () => {
    const fake = createFakeRunApi({ hold: false });
    const manager = createManager(fake.api);
    await manager.start();
    const parent = await manager.dispatch(newRequest(workspace));
    expect((await manager.wait({ discussion_ref: parent.discussion_ref })).status).toBe("completed");

    const child = await manager.dispatch({
      kind: "follow_up",
      parent_discussion_ref: parent.discussion_ref,
      question: "what changes?",
      materials: [],
    });
    const completed = await manager.wait({ discussion_ref: child.discussion_ref });
    expect(completed.status).toBe("completed");
    expect(completed.participant_statuses.map((member) => member.session_mode)).toEqual([
      "rebuilt",
      "rebuilt",
    ]);

    const childDispatches = fake.dispatched.slice(8);
    const participantA = childDispatches.find(
      (item) => promptJsonSection(item.input.prompt, "ROLE").focus === "reliability",
    );
    const handoff = turnInput(participantA.input.prompt).parent_handoff;
    expect(handoff.events.some((event) => event.payload?.member_id === "a")).toBe(true);
    expect(handoff.events.some((event) => event.payload?.member_id === "b")).toBe(false);
    const moderation = handoff.events.find((event) => event.type === "moderation.plan.accepted");
    expect(moderation.payload.output.assignments.map((item) => item.participant_id)).toEqual(["a"]);
    await manager.shutdown();
  });

  it("repairs a torn event tail during query without requiring a daemon restart", async () => {
    const fake = createFakeRunApi({ hold: true });
    const manager = createManager(fake.api);
    await manager.start();
    const accepted = await manager.dispatch(newRequest(workspace));
    const id = accepted.discussion_ref.discussion_id;
    await waitUntil(async () => (await readDiscussionState(id)).active_run_refs.length === 2);
    await manager.shutdown();

    const eventPath = path.join(discussionDirFor(id), "events.jsonl");
    await fsp.appendFile(eventPath, '{"sequence":999');
    const queried = await manager.query({ discussion_ref: accepted.discussion_ref });

    expect(queried.status).toBe("running");
    expect(queried.recent_events.at(-1).type).toBe("discussion.recovered");
    expect(await fsp.readFile(eventPath, "utf8")).toMatch(/\n$/);
  });

  it("records phase deadline as the concrete cause of a quorum failure", async () => {
    const fake = createFakeRunApi({ hold: true });
    const manager = new DiscussionManager({
      run_api: fake.api,
      poll_interval_ms: 5,
      wait_window_ms: 5000,
      phase_durations_ms: {
        independent: 50,
        moderating: 2000,
        challenge: 2000,
        revision: 2000,
        synthesizing: 2000,
      },
    });
    await manager.start();
    const accepted = await manager.dispatch(newRequest(workspace));
    const terminal = await manager.wait({ discussion_ref: accepted.discussion_ref });

    expect(terminal).toMatchObject({
      status: "failed",
      completion_quality: "failed",
      error: {
        code: "quorum_not_met",
        cause: { error: { code: "turn_deadline" } },
      },
      failure_summary: {
        phase: "independent",
        last_cause: { error: { code: "turn_deadline" } },
      },
    });
    expect(
      terminal.phase_statistics.find((item) => item.phase === "independent"),
    ).toMatchObject({ required: 2, accepted: 0, failed: 2, timed_out: 2 });
    expect(fake.cancelled.size).toBe(2);
    await manager.shutdown();
  });
});

function createManager(runApi) {
  return new DiscussionManager({
    run_api: runApi,
    poll_interval_ms: 5,
    wait_window_ms: 5000,
    phase_durations_ms: {
      independent: 2000,
      moderating: 2000,
      challenge: 2000,
      revision: 2000,
      synthesizing: 2000,
    },
  });
}

function newRequest(cwd) {
  return {
    kind: "new",
    objective: "test lifecycle",
    question: "does it recover?",
    cwd,
    materials: [],
    host: { agent_id: "claude-code", metadata: {} },
    participants: [
      {
        participant_id: "a",
        agent_id: "claude-code",
        role: "reviewer",
        focus: "reliability",
        metadata: {},
      },
      {
        participant_id: "b",
        agent_id: "claude-code",
        role: "reviewer",
        focus: "protocol",
        metadata: {},
      },
    ],
    quorum: 2,
  };
}

function createFakeRunApi(options) {
  const records = new Map();
  const dispatched = [];
  const cancelled = new Set();
  let sequence = 0;
  const fake = {
    hold: options.hold,
    dispatched,
    cancelled,
    api: {
      dispatch: async (input, internal) => {
        sequence += 1;
        const runRef = { run_id: `fake-run-${sequence}` };
        const cliSessionRef = input.cli_session_ref ?? {
          agent_id: input.agent_id,
          native_session_id: `fake-session-${sequence}`,
        };
        const record = {
          run_ref: runRef,
          prompt: input.prompt,
          status: fake.hold ? "running" : "completed",
          cli_session_ref: cliSessionRef,
          session_generation: (internal?.expected_session_generation ?? -1) + 1,
          completed_at: fake.hold ? undefined : new Date().toISOString(),
        };
        records.set(runRef.run_id, record);
        dispatched.push({ input, internal, run_ref: runRef });
        return {
          status: "accepted",
          run_ref: runRef,
          cli_session_ref: cliSessionRef,
          session_generation: record.session_generation,
        };
      },
      query: async ({ run_ref: runRef }) => snapshot(records.get(runRef.run_id)),
      cancel: async ({ run_ref: runRef }) => {
        const record = records.get(runRef.run_id);
        cancelled.add(runRef.run_id);
        record.status = "cancelled";
        record.completed_at = new Date().toISOString();
        return snapshot(record);
      },
      retain: async () => undefined,
    },
    completeAll() {
      for (const record of records.values()) {
        if (record.status === "running") {
          record.status = "completed";
          record.completed_at = new Date().toISOString();
        }
      }
    },
  };
  return fake;
}

function snapshot(record) {
  const result = {
    status: record.status,
    run_ref: record.run_ref,
    cli_session_ref: record.cli_session_ref,
    session_generation: record.session_generation,
    completed_at: record.completed_at,
  };
  if (record.status === "completed") {
    result.content = [{ type: "text", text: outputContract(record.prompt) }];
  }
  if (record.status === "cancelled") {
    result.content = [{ type: "text", text: "Run cancelled." }];
  }
  return result;
}

function outputContract(prompt) {
  const marker = "[OUTPUT CONTRACT]\n";
  const index = prompt.lastIndexOf(marker);
  if (index < 0) throw new Error("fake run received a prompt without an output contract");
  return prompt.slice(index + marker.length).trim();
}

function turnInput(prompt) {
  const startMarker = "[TURN INPUT]\n";
  const endMarker = "\n\n[OUTPUT CONTRACT]";
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf(endMarker, start);
  return JSON.parse(prompt.slice(start + startMarker.length, end));
}

function promptJsonSection(prompt, name) {
  const startMarker = `[${name}]\n`;
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf("\n\n[", start + startMarker.length);
  return JSON.parse(prompt.slice(start + startMarker.length, end));
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

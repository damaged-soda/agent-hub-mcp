import { describe, expect, it } from "vitest";
import {
  completionQuality,
  discussionListResult,
  failureSummary,
  normalizeDiscussionListInput,
  phaseStatistics,
} from "../src/discussion-observability.js";

describe("discussion observability", () => {
  it("distinguishes complete, partial, and failed terminal records", () => {
    expect(completionQuality({ status: "completed", protocol_integrity: "complete" })).toBe(
      "complete",
    );
    expect(completionQuality({ status: "completed", protocol_integrity: "degraded" })).toBe(
      "partial",
    );
    expect(completionQuality({ status: "failed" })).toBe("failed");
    expect(completionQuality({ status: "cancelled" })).toBeNull();
    expect(completionQuality({ status: "running" })).toBeNull();
  });

  it("reports phase coverage, timing, and deadline attempts without reading run logs", () => {
    const state = failedState("discussion-one", "2026-08-29T00:00:00.000Z");
    const stats = phaseStatistics(state, [
      phaseEvent(1, "independent", "2026-08-29T00:00:00.000Z"),
      phaseEvent(2, "moderating", "2026-08-29T00:05:00.000Z"),
      phaseEvent(3, "challenge", "2026-08-29T00:06:00.000Z"),
      phaseEvent(4, "revision", "2026-08-29T00:07:00.000Z"),
      phaseEvent(5, "synthesizing", "2026-08-29T00:08:00.000Z"),
      {
        sequence: 6,
        type: "discussion.failed",
        timestamp: "2026-08-29T00:13:00.000Z",
        payload: {},
      },
    ]);

    expect(stats.find((item) => item.phase === "independent")).toMatchObject({
      required: 2,
      accepted: 2,
      duration_ms: 300_000,
    });
    expect(stats.find((item) => item.phase === "challenge")).toMatchObject({
      required: 2,
      accepted: 0,
      pending: 2,
      duration_ms: 60_000,
    });
    expect(stats.find((item) => item.phase === "synthesizing")).toMatchObject({
      required: 1,
      failed: 1,
      timed_out: 1,
      duration_ms: 300_000,
    });
  });

  it("keeps the terminal error while exposing the concrete last failed attempt", () => {
    const summary = failureSummary(
      failedState("discussion-one", "2026-08-29T00:00:00.000Z"),
    );

    expect(summary).toMatchObject({
      phase: "synthesizing",
      primary_error: {
        code: "decision_failed",
        message: "Host did not produce a DecisionRecord",
      },
      last_cause: {
        member_id: "host",
        turn: "decision_record",
        attempt: 2,
        error: { code: "turn_deadline" },
        remaining_ms_at_dispatch: 9870,
      },
    });
    expect(summary.last_cause).not.toHaveProperty("_timestamp");
    expect(summary.failed_attempts).toHaveLength(2);
    expect(summary.failed_attempts_total).toBe(2);
  });

  it("does not report a recovered attempt as a Discussion failure", () => {
    const state = failedState("recovered", "2026-08-29T00:00:00.000Z");
    state.status = "completed";
    state.protocol_integrity = "complete";
    state.error = null;
    state.members.host.turns.decision_record = { status: "accepted" };

    expect(failureSummary(state)).toBeNull();
  });

  it("bounds failed attempt details while preserving totals", () => {
    const state = failedState("many-attempts", "2026-08-29T00:00:00.000Z");
    state.turn_attempts = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `decision_record:host:${index + 1}`,
        {
          status: "failed",
          error: { code: "structured_output_invalid", message: `failure ${index + 1}` },
          completed_at: new Date(Date.parse("2026-08-29T00:00:00.000Z") + index).toISOString(),
        },
      ]),
    );

    const summary = failureSummary(state);
    expect(summary.failed_attempts).toHaveLength(20);
    expect(summary.failed_attempts_total).toBe(25);
    expect(summary.failed_attempts[0].attempt).toBe(6);
    expect(summary.last_cause.attempt).toBe(25);
  });

  it("lists newest records with status, relative-time, cwd, and limit filters", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    const old = failedState("old", "2026-08-20T00:00:00.000Z");
    const recent = failedState("recent", "2026-08-29T10:00:00.000Z");
    recent.status = "completed";
    recent.protocol_integrity = "degraded";
    recent.error = null;
    recent.members.host.turns.decision_record.status = "accepted";
    recent.turn_attempts = {};

    const result = discussionListResult(
      [old, recent],
      [],
      { status: "completed,failed", since: "7d", cwd: "/tmp/workspace", limit: 1 },
      now,
    );

    expect(result.discussions).toHaveLength(1);
    expect(result.discussions[0]).toMatchObject({
      discussion_ref: { discussion_id: "recent" },
      completion_quality: "partial",
    });
    expect(result.discussions[0].failure_summary).toBeNull();
    expect(result.total_matching).toBe(1);
    expect(result.has_more).toBe(false);
    expect(result.filters.since).toBe("2026-08-22T12:00:00.000Z");
  });

  it("rejects ambiguous list filters", () => {
    expect(() => normalizeDiscussionListInput({ status: "finished" })).toThrow(
      /Unknown discussion status/,
    );
    expect(() => normalizeDiscussionListInput({ since: "yesterday" })).toThrow(
      /ISO 8601/,
    );
    expect(() => normalizeDiscussionListInput({ cwd: "relative" })).toThrow(/absolute/);
    expect(() => normalizeDiscussionListInput({ limit: 201 })).toThrow(/1 to 200/);
  });
});

function failedState(id, createdAt) {
  return {
    schema_version: 1,
    protocol_version: 1,
    discussion_id: id,
    status: "failed",
    phase: "synthesizing",
    protocol_integrity: "degraded",
    objective: "Investigate the failure\nwithout leaking the full prompt",
    cwd: "/tmp/workspace",
    quorum: 2,
    created_at: createdAt,
    completed_at: "2026-08-29T00:13:00.000Z",
    error: { code: "decision_failed", message: "Host did not produce a DecisionRecord" },
    members: {
      host: {
        member_id: "host",
        formal_turns_completed: 1,
        turns: {
          moderation_plan: { status: "accepted" },
          decision_record: {
            status: "failed",
            error: { code: "turn_deadline", message: "phase deadline reached" },
          },
        },
      },
      participants: {
        one: {
          member_id: "one",
          formal_turns_completed: 1,
          turns: { participant_memo: { status: "accepted" } },
        },
        two: {
          member_id: "two",
          formal_turns_completed: 1,
          turns: { participant_memo: { status: "accepted" } },
        },
      },
    },
    turn_attempts: {
      "decision_record:host:1": {
        status: "failed",
        error: { code: "structured_output_invalid", message: "unknown provenance" },
        run_ref: { run_id: "run-one" },
        completed_at: "2026-08-29T00:12:00.000Z",
      },
      "decision_record:host:2": {
        status: "failed",
        error: { code: "turn_deadline", message: "phase deadline reached" },
        run_ref: { run_id: "run-two" },
        remaining_ms_at_dispatch: 9870,
        completed_at: "2026-08-29T00:13:00.000Z",
      },
    },
    results: {
      participant_memos: { one: {}, two: {} },
    },
  };
}

function phaseEvent(sequence, phase, timestamp) {
  return {
    sequence,
    type: "phase.started",
    timestamp,
    payload: { phase },
  };
}

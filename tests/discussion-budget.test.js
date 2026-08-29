import { describe, expect, it } from "vitest";
import {
  discussionAbsoluteDeadlines,
  discussionBudgetStatus,
  discussionPhaseDeadline,
  hasRepairBudget,
  inheritedDiscussionBudgetProfile,
  resolveDiscussionBudget,
} from "../src/discussion-budget.js";

const START = Date.parse("2026-08-29T00:00:00.000Z");
const MINUTE = 60 * 1000;

describe("discussion budget profiles", () => {
  it("rejects unknown or internally inconsistent frozen budgets", () => {
    expect(() => resolveDiscussionBudget("unbounded")).toThrow(/Unknown Discussion budget profile/);
    const invalid = resolveDiscussionBudget("quick");
    invalid.phase_minimums_ms.independent = invalid.total_ms;
    expect(() => discussionAbsoluteDeadlines(START, invalid)).toThrow(
      /phase minimums exceed total budget/,
    );
  });

  it("keeps quick absolute cutoffs compatible with the legacy 30-minute schedule", () => {
    const budget = resolveDiscussionBudget("quick");
    const deadlines = discussionAbsoluteDeadlines(START, budget);

    expect(offsets(deadlines)).toEqual({
      independent: 10,
      moderating: 13,
      challenge: 19,
      revision: 25,
      synthesizing: 30,
    });
  });

  it("freezes standard and research hard caps with future phase reserves", () => {
    expect(offsets(discussionAbsoluteDeadlines(START, resolveDiscussionBudget("standard"))))
      .toEqual({
        independent: 25,
        moderating: 30,
        challenge: 40,
        revision: 50,
        synthesizing: 60,
      });
    expect(offsets(discussionAbsoluteDeadlines(START, resolveDiscussionBudget("research"))))
      .toEqual({
        independent: 37,
        moderating: 45,
        challenge: 60,
        revision: 75,
        synthesizing: 90,
      });
  });

  it("carries early completion forward without crossing the reserved absolute cutoff", () => {
    const budget = resolveDiscussionBudget("quick");
    const deadlines = discussionAbsoluteDeadlines(START, budget);

    expect(
      discussionPhaseDeadline(START + 5 * MINUTE, "moderating", deadlines.moderating, budget),
    ).toBe(START + 10 * MINUTE);
    expect(
      discussionPhaseDeadline(START + 12 * MINUTE, "moderating", deadlines.moderating, budget),
    ).toBe(START + 13 * MINUTE);
  });

  it("reports terminal elapsed time instead of consuming the whole budget after completion", () => {
    const budget = resolveDiscussionBudget("standard");
    const state = {
      budget,
      phase: "synthesizing",
      accepted_at: new Date(START).toISOString(),
      completed_at: new Date(START + 12 * MINUTE).toISOString(),
      deadline_at: new Date(START + 60 * MINUTE).toISOString(),
      phase_deadline_at: new Date(START + 20 * MINUTE).toISOString(),
    };

    expect(discussionBudgetStatus(state, START + 2 * 60 * MINUTE)).toMatchObject({
      profile: "standard",
      total_ms: 60 * MINUTE,
      repair_min_ms: 5 * MINUTE,
      elapsed_ms: 12 * MINUTE,
      remaining_ms: 48 * MINUTE,
      phase_remaining_ms: 8 * MINUTE,
    });
  });

  it("requires the full repair window and preserves legacy records without guessing", () => {
    const budget = resolveDiscussionBudget("standard");
    const state = {
      budget,
      phase_deadline_at: new Date(START + 5 * MINUTE).toISOString(),
    };
    expect(hasRepairBudget(state, START)).toBe(true);
    expect(hasRepairBudget(state, START + 1)).toBe(false);

    expect(discussionBudgetStatus({
      accepted_at: new Date(START).toISOString(),
      deadline_at: new Date(START + 30 * MINUTE).toISOString(),
      phase: "challenge",
    }, START + 3 * MINUTE)).toMatchObject({
      profile: "legacy",
      source: "legacy",
      total_ms: 30 * MINUTE,
      repair_min_ms: 0,
      elapsed_ms: 3 * MINUTE,
      remaining_ms: 27 * MINUTE,
      future_phase_reserve_ms: null,
    });
    expect(inheritedDiscussionBudgetProfile({})).toBe("quick");
    expect(inheritedDiscussionBudgetProfile({ budget_profile: "research" })).toBe("research");
    expect(inheritedDiscussionBudgetProfile({
      budget_profile: "quick",
      budget: resolveDiscussionBudget("standard"),
    })).toBe("standard");
  });
});

function offsets(deadlines) {
  return Object.fromEntries(
    Object.entries(deadlines).map(([phase, value]) => [
      phase,
      (Date.parse(value) - START) / MINUTE,
    ]),
  );
}

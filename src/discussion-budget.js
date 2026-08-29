export const DISCUSSION_PHASES = Object.freeze([
  "independent",
  "moderating",
  "challenge",
  "revision",
  "synthesizing",
]);

export const DISCUSSION_BUDGET_PROFILE_NAMES = Object.freeze([
  "quick",
  "standard",
  "research",
]);

export const DEFAULT_DISCUSSION_BUDGET_PROFILE = "standard";

const MINUTE_MS = 60 * 1000;
const PROFILE_DEFINITIONS = Object.freeze({
  quick: profile("quick", {
    total_minutes: 30,
    repair_min_minutes: 2,
    minimum_minutes: {
      independent: 10,
      moderating: 3,
      challenge: 6,
      revision: 6,
      synthesizing: 5,
    },
    maximum_minutes: {
      independent: 15,
      moderating: 5,
      challenge: 10,
      revision: 10,
      synthesizing: 8,
    },
  }),
  standard: profile("standard", {
    total_minutes: 60,
    repair_min_minutes: 5,
    minimum_minutes: {
      independent: 15,
      moderating: 5,
      challenge: 10,
      revision: 10,
      synthesizing: 10,
    },
    maximum_minutes: {
      independent: 25,
      moderating: 10,
      challenge: 20,
      revision: 20,
      synthesizing: 15,
    },
  }),
  research: profile("research", {
    total_minutes: 90,
    repair_min_minutes: 8,
    minimum_minutes: {
      independent: 25,
      moderating: 8,
      challenge: 15,
      revision: 15,
      synthesizing: 15,
    },
    maximum_minutes: {
      independent: 40,
      moderating: 15,
      challenge: 30,
      revision: 25,
      synthesizing: 20,
    },
  }),
});

export function resolveDiscussionBudget(profileName, phaseDurationsOverride = null) {
  if (!DISCUSSION_BUDGET_PROFILE_NAMES.includes(profileName)) {
    throw codedError("invalid_budget_profile", `Unknown Discussion budget profile: ${profileName}`);
  }
  if (phaseDurationsOverride) {
    const durations = validatedPhaseMap(phaseDurationsOverride, "phase duration override");
    return Object.freeze({
      schema_version: 1,
      profile: profileName,
      source: "override",
      total_ms: sumPhaseMap(durations),
      repair_min_ms: 0,
      phase_minimums_ms: Object.freeze({ ...durations }),
      phase_maximums_ms: Object.freeze({ ...durations }),
    });
  }
  return structuredClone(PROFILE_DEFINITIONS[profileName]);
}

export function discussionAbsoluteDeadlines(acceptedAt, budget) {
  const accepted = finiteTimestamp(acceptedAt, "acceptedAt");
  validateBudget(budget);
  const result = {};
  for (const [index, phase] of DISCUSSION_PHASES.entries()) {
    const futureReserve = DISCUSSION_PHASES.slice(index + 1)
      .reduce((sum, later) => sum + budget.phase_minimums_ms[later], 0);
    result[phase] = new Date(accepted + budget.total_ms - futureReserve).toISOString();
  }
  return result;
}

export function discussionPhaseDeadline(startedAt, phase, absoluteDeadline, budget) {
  const started = finiteTimestamp(startedAt, "startedAt");
  const absolute = finiteTimestamp(absoluteDeadline, "absoluteDeadline");
  validateBudget(budget);
  if (!DISCUSSION_PHASES.includes(phase)) {
    throw codedError("invalid_discussion_phase", `Unknown Discussion phase: ${phase}`);
  }
  return Math.min(started + budget.phase_maximums_ms[phase], absolute);
}

export function discussionBudgetStatus(state, now = Date.now()) {
  const acceptedAt = Date.parse(state?.accepted_at ?? "");
  const deadlineAt = Date.parse(state?.deadline_at ?? "");
  const completedAt = Date.parse(state?.completed_at ?? "");
  const observation = Number.isFinite(completedAt) ? completedAt : now;
  const storedBudget = state?.budget;
  const totalMs = Number.isFinite(storedBudget?.total_ms)
    ? storedBudget.total_ms
    : Number.isFinite(acceptedAt) && Number.isFinite(deadlineAt)
      ? Math.max(0, deadlineAt - acceptedAt)
      : null;
  const elapsedMs = Number.isFinite(acceptedAt) && Number.isFinite(totalMs)
    ? Math.min(totalMs, Math.max(0, observation - acceptedAt))
    : null;
  const remainingMs = Number.isFinite(deadlineAt)
    ? Math.max(0, deadlineAt - observation)
    : null;
  const phaseDeadline = Date.parse(state?.phase_deadline_at ?? "");
  const phaseRemainingMs = Number.isFinite(phaseDeadline)
    ? Math.max(0, phaseDeadline - observation)
    : null;
  return {
    profile: storedBudget?.profile ?? state?.budget_profile ?? "legacy",
    source: storedBudget?.source ?? "legacy",
    total_ms: totalMs,
    repair_min_ms: storedBudget?.repair_min_ms ?? 0,
    elapsed_ms: elapsedMs,
    remaining_ms: remainingMs,
    phase_remaining_ms: phaseRemainingMs,
    future_phase_reserve_ms: futurePhaseReserve(state),
  };
}

export function hasRepairBudget(state, now = Date.now()) {
  const minimum = state?.budget?.repair_min_ms ?? 0;
  const deadline = Date.parse(state?.phase_deadline_at ?? "");
  if (!Number.isFinite(deadline)) return false;
  return deadline - now >= minimum;
}

export function inheritedDiscussionBudgetProfile(parentState) {
  return parentState?.budget?.profile ?? parentState?.budget_profile ?? "quick";
}

function profile(name, input) {
  const minimums = minutePhaseMap(input.minimum_minutes);
  const maximums = minutePhaseMap(input.maximum_minutes);
  const totalMs = input.total_minutes * MINUTE_MS;
  if (sumPhaseMap(minimums) > totalMs) {
    throw new Error("Discussion phase minimums exceed the total budget");
  }
  for (const phase of DISCUSSION_PHASES) {
    if (maximums[phase] < minimums[phase]) {
      throw new Error(`Discussion phase maximum is below its minimum: ${phase}`);
    }
  }
  return Object.freeze({
    schema_version: 1,
    profile: name,
    source: "profile",
    total_ms: totalMs,
    repair_min_ms: input.repair_min_minutes * MINUTE_MS,
    phase_minimums_ms: Object.freeze(minimums),
    phase_maximums_ms: Object.freeze(maximums),
  });
}

function minutePhaseMap(value) {
  return Object.fromEntries(
    DISCUSSION_PHASES.map((phase) => [phase, value[phase] * MINUTE_MS]),
  );
}

function validatedPhaseMap(value, label) {
  const result = {};
  for (const phase of DISCUSSION_PHASES) {
    const duration = value?.[phase];
    if (!Number.isFinite(duration) || duration <= 0) {
      throw codedError("invalid_discussion_budget", `${label} is invalid for ${phase}`);
    }
    result[phase] = duration;
  }
  return result;
}

function validateBudget(budget) {
  if (!budget || !Number.isFinite(budget.total_ms) || budget.total_ms <= 0) {
    throw codedError("invalid_discussion_budget", "Discussion total budget is invalid");
  }
  if (
    !Number.isFinite(budget.repair_min_ms) ||
    budget.repair_min_ms < 0 ||
    budget.repair_min_ms > budget.total_ms
  ) {
    throw codedError("invalid_discussion_budget", "Discussion repair minimum is invalid");
  }
  const minimums = validatedPhaseMap(budget.phase_minimums_ms, "phase minimum");
  const maximums = validatedPhaseMap(budget.phase_maximums_ms, "phase maximum");
  if (sumPhaseMap(minimums) > budget.total_ms) {
    throw codedError("invalid_discussion_budget", "Discussion phase minimums exceed total budget");
  }
  for (const phase of DISCUSSION_PHASES) {
    if (maximums[phase] < minimums[phase]) {
      throw codedError(
        "invalid_discussion_budget",
        `Discussion phase maximum is below its minimum: ${phase}`,
      );
    }
  }
}

function sumPhaseMap(value) {
  return DISCUSSION_PHASES.reduce((sum, phase) => sum + value[phase], 0);
}

function finiteTimestamp(value, label) {
  const parsed = typeof value === "number" ? value : Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) {
    throw codedError("invalid_discussion_budget", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function futurePhaseReserve(state) {
  const minimums = state?.budget?.phase_minimums_ms;
  const phaseIndex = DISCUSSION_PHASES.indexOf(state?.phase);
  if (!minimums || phaseIndex < 0) return null;
  return DISCUSSION_PHASES.slice(phaseIndex + 1)
    .reduce((sum, phase) => sum + minimums[phase], 0);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

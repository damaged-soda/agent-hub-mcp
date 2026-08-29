import path from "node:path";
import { discussionBudgetStatus } from "./discussion-budget.js";

const PHASES = Object.freeze([
  "independent",
  "moderating",
  "challenge",
  "revision",
  "synthesizing",
]);
const TURN_PHASES = Object.freeze({
  participant_memo: "independent",
  moderation_plan: "moderating",
  challenge_response: "challenge",
  revision_memo: "revision",
  decision_record: "synthesizing",
});
const PHASE_TURNS = Object.freeze(
  Object.fromEntries(Object.entries(TURN_PHASES).map(([turn, phase]) => [phase, turn])),
);
const TERMINAL_EVENT_TYPES = new Set([
  "discussion.completed",
  "discussion.failed",
  "discussion.cancelled",
]);
const LIST_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
const TIMEOUT_CODES = new Set(["turn_deadline", "turn_late", "phase_deadline"]);
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const ERROR_MESSAGE_LIMIT = 1024;
const OBJECTIVE_SUMMARY_LIMIT = 240;
const MAX_FAILED_ATTEMPTS = 20;

export function completionQuality(state) {
  if (state?.status === "completed") {
    return state.protocol_integrity === "complete" ? "complete" : "partial";
  }
  if (state?.status === "failed" || state?.status === "unknown") return "failed";
  return null;
}

export function phaseStatistics(state, events = []) {
  const participants = Object.values(state?.members?.participants ?? {});
  const effective = participants.filter(
    (member) => member.turns?.participant_memo?.status === "accepted",
  );
  const reachedIndex = PHASES.indexOf(state?.phase);
  const timings = phaseTimings(state, events);

  return PHASES.map((phase, phaseIndex) => {
    const kind = PHASE_TURNS[phase];
    const members = ["moderating", "synthesizing"].includes(phase)
      ? state?.members?.host
        ? [state.members.host]
        : []
      : phase === "independent"
        ? participants
        : effective;
    const hasTurnState = members.some((member) => member.turns?.[kind]);
    const reached = reachedIndex >= phaseIndex || hasTurnState || timings[phase]?.started_at;
    const required = reached ? members.length : 0;
    const accepted = members.filter((member) => member.turns?.[kind]?.status === "accepted").length;
    const failed = members.filter((member) => member.turns?.[kind]?.status === "failed").length;
    const attempts = attemptsForKind(state, kind);
    return {
      phase,
      required,
      accepted,
      failed,
      pending: Math.max(0, required - accepted - failed),
      attempts: {
        total: attempts.length,
        requested: attempts.filter((attempt) => attempt.status === "requested").length,
        running: attempts.filter((attempt) => attempt.status === "running").length,
        completed: attempts.filter((attempt) => attempt.status === "completed").length,
        failed: attempts.filter((attempt) => attempt.status === "failed").length,
        late: attempts.filter((attempt) => attempt.status === "late").length,
        skipped: attempts.filter((attempt) => attempt.status === "skipped").length,
      },
      timed_out: attempts.filter((attempt) => TIMEOUT_CODES.has(attempt.error?.code)).length,
      started_at: timings[phase]?.started_at ?? null,
      ended_at: timings[phase]?.ended_at ?? null,
      duration_ms: timings[phase]?.duration_ms ?? null,
    };
  });
}

export function failureSummary(state, topError = state?.error) {
  const failedAttempts = Object.entries(state?.turn_attempts ?? {})
    .filter(([, attempt]) => ["failed", "late", "skipped"].includes(attempt.status))
    .map(([attemptKey, attempt], index) => failedAttempt(attemptKey, attempt, index))
    .sort(compareFailures);
  const failedTurns = failedMemberTurns(state);
  if (!topError && failedTurns.length === 0) return null;

  const rawLastCause = failedAttempts.at(-1) ?? failedTurns.at(-1) ?? null;
  const lastCause = rawLastCause && "_order" in rawLastCause
    ? stripFailureSortFields(rawLastCause)
    : rawLastCause;
  return {
    phase: lastCause?.phase ?? state?.phase ?? null,
    primary_error: topError ? compactError(topError) : null,
    last_cause: lastCause,
    failed_turns: failedTurns,
    failed_turns_total: failedTurns.length,
    failed_attempts: failedAttempts.slice(-MAX_FAILED_ATTEMPTS).map(stripFailureSortFields),
    failed_attempts_total: failedAttempts.length,
  };
}

export function enrichTerminalError(error, summary) {
  if (!error) return null;
  const enriched = compactError(error);
  if (summary?.last_cause) enriched.cause = summary.last_cause;
  return enriched;
}

export function normalizeDiscussionListInput(input = {}, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw codedError("invalid_discussion_list", "Discussion list input must be an object");
  }
  const statusValues = input.status === undefined
    ? []
    : Array.isArray(input.status)
      ? input.status
      : String(input.status).split(",");
  const statuses = statusValues.map((value) => String(value).trim()).filter(Boolean);
  for (const status of statuses) {
    if (!LIST_STATUSES.has(status)) {
      throw codedError("invalid_discussion_list", `Unknown discussion status: ${status}`);
    }
  }

  let since = null;
  if (input.since !== undefined && input.since !== null && input.since !== "") {
    since = parseSince(input.since, now);
  }

  let cwd = null;
  if (input.cwd !== undefined && input.cwd !== null && input.cwd !== "") {
    if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) {
      throw codedError("invalid_discussion_list", "Discussion list cwd must be absolute");
    }
    cwd = path.resolve(input.cwd);
  }

  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
    throw codedError(
      "invalid_discussion_list",
      `Discussion list limit must be an integer from 1 to ${MAX_LIST_LIMIT}`,
    );
  }
  return { statuses, since, cwd, limit };
}

export function discussionListResult(states, sourceErrors = [], input = {}, now = Date.now()) {
  const filters = normalizeDiscussionListInput(input, now);
  const filtered = states
    .filter((state) => filters.statuses.length === 0 || filters.statuses.includes(state.status))
    .filter((state) => !filters.since || Date.parse(state.created_at ?? "") >= Date.parse(filters.since))
    .filter((state) => !filters.cwd || path.resolve(state.cwd ?? "/") === filters.cwd)
    .sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
  return {
    schema_version: 1,
    kind: "agent-discussion-list",
    filters: {
      status: filters.statuses,
      since: filters.since,
      cwd: filters.cwd,
      limit: filters.limit,
    },
    discussions: filtered.slice(0, filters.limit).map((state) => discussionSummary(state, now)),
    total_matching: filtered.length,
    has_more: filtered.length > filters.limit,
    source_errors: sourceErrors,
  };
}

export function discussionSummary(state, now = Date.now()) {
  const summary = failureSummary(state);
  return {
    schema_version: state.schema_version,
    protocol_version: state.protocol_version,
    discussion_ref: { discussion_id: state.discussion_id },
    parent_discussion_ref: state.parent_discussion_ref ?? null,
    status: state.status,
    phase: state.phase,
    completion_quality: completionQuality(state),
    protocol_integrity: state.protocol_integrity ?? null,
    conclusion_strength: state.conclusion_strength ?? null,
    budget_status: discussionBudgetStatus(state, now),
    objective_summary: compactText(state.objective, OBJECTIVE_SUMMARY_LIMIT),
    cwd: state.cwd ?? null,
    quorum: state.quorum ?? null,
    progress: progressFromState(state),
    failure_summary: listFailureSummary(summary),
    created_at: state.created_at ?? null,
    started_at: state.started_at ?? null,
    accepted_at: state.accepted_at ?? null,
    completed_at: state.completed_at ?? null,
    updated_at: state.updated_at ?? null,
    expires_at: state.expires_at ?? null,
  };
}

export function progressFromState(state) {
  const participants = Object.values(state?.members?.participants ?? {});
  return {
    participants_total: participants.length,
    participants_effective: participants.filter(
      (member) => member.turns?.participant_memo?.status === "accepted",
    ).length,
    formal_turns_completed:
      participants.reduce((sum, member) => sum + (member.formal_turns_completed ?? 0), 0) +
      (state?.members?.host?.formal_turns_completed ?? 0),
    attempts_completed: Object.values(state?.turn_attempts ?? {}).filter((attempt) =>
      ["completed", "failed", "late", "skipped"].includes(attempt.status),
    ).length,
  };
}

function phaseTimings(state, events) {
  const starts = new Map();
  for (const event of events) {
    if (event.type === "phase.started" && PHASES.includes(event.payload?.phase)) {
      starts.set(event.payload.phase, event.timestamp);
    }
  }
  const terminal = events.findLast((event) => TERMINAL_EVENT_TYPES.has(event.type));
  const result = {};
  for (const [index, phase] of PHASES.entries()) {
    const startedAt = starts.get(phase);
    if (!startedAt) continue;
    const nextStart = PHASES.slice(index + 1)
      .map((nextPhase) => starts.get(nextPhase))
      .find(Boolean);
    const endedAt = nextStart ?? terminal?.timestamp ?? state?.completed_at ?? null;
    const duration = endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN;
    result[phase] = {
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : null,
    };
  }
  return result;
}

function attemptsForKind(state, kind) {
  return Object.entries(state?.turn_attempts ?? {})
    .filter(([attemptKey]) => parseAttemptKey(attemptKey).kind === kind)
    .map(([, attempt]) => attempt);
}

function failedAttempt(attemptKey, attempt, order) {
  const parsed = parseAttemptKey(attemptKey);
  const timestamp = attempt.completed_at ?? attempt.dispatched_at ?? attempt.requested_at ?? "";
  return {
    phase: TURN_PHASES[parsed.kind] ?? null,
    member_id: parsed.member_id,
    turn: parsed.kind,
    attempt: parsed.attempt,
    status: attempt.status,
    error: compactError(attempt.error),
    run_ref: attempt.run_ref ?? null,
    remaining_ms_at_dispatch: attempt.remaining_ms_at_dispatch ?? null,
    remaining_ms_when_skipped: attempt.remaining_ms_when_skipped ?? null,
    requested_at: attempt.requested_at ?? null,
    completed_at: attempt.completed_at ?? null,
    _timestamp: timestamp,
    _order: order,
  };
}

function failedMemberTurns(state) {
  const members = [state?.members?.host, ...Object.values(state?.members?.participants ?? {})]
    .filter(Boolean);
  const failures = [];
  for (const member of members) {
    for (const [kind, turn] of Object.entries(member.turns ?? {})) {
      if (turn.status !== "failed") continue;
      failures.push({
        phase: TURN_PHASES[kind] ?? null,
        member_id: member.member_id,
        turn: kind,
        error: compactError(turn.error),
      });
    }
  }
  return failures;
}

function listFailureSummary(summary) {
  if (!summary) return null;
  return {
    phase: summary.phase,
    primary_error: summary.primary_error,
    last_cause: summary.last_cause,
    failed_turns_total: summary.failed_turns_total,
    failed_attempts_total: summary.failed_attempts_total,
  };
}

function parseAttemptKey(attemptKey) {
  const first = attemptKey.indexOf(":");
  const last = attemptKey.lastIndexOf(":");
  const attempt = Number(attemptKey.slice(last + 1));
  return {
    kind: first >= 0 ? attemptKey.slice(0, first) : attemptKey,
    member_id: first >= 0 && last > first ? attemptKey.slice(first + 1, last) : null,
    attempt: Number.isInteger(attempt) ? attempt : null,
  };
}

function compareFailures(left, right) {
  const leftTime = Date.parse(left._timestamp || "");
  const rightTime = Date.parse(right._timestamp || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left._order - right._order;
}

function stripFailureSortFields({ _order, _timestamp, ...failure }) {
  return failure;
}

function compactError(error) {
  if (!error) return null;
  return {
    code: error.code ?? "discussion_error",
    message: compactText(error.message ?? error, ERROR_MESSAGE_LIMIT),
  };
}

function compactText(value, limit) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function parseSince(value, now) {
  if (typeof value !== "string") {
    throw codedError("invalid_discussion_list", "Discussion list since must be a string");
  }
  const relative = value.trim().match(/^(\d+)([mhdw])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const multipliers = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return new Date(now - amount * multipliers[relative[2].toLowerCase()]).toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw codedError(
      "invalid_discussion_list",
      "Discussion list since must be ISO 8601 or a duration such as 24h or 7d",
    );
  }
  return new Date(parsed).toISOString();
}

function recordTimestamp(state) {
  const parsed = Date.parse(state.created_at ?? state.updated_at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

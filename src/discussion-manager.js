import crypto from "node:crypto";
import {
  cancelAgentRun,
  dispatchToAgent,
  queryAgentRunSnapshot,
  retainAgentRun,
} from "./runs.js";
import { getAdapter } from "./adapters.js";
import { validateRequestPaths } from "./security.js";
import {
  aggregateEvidenceStatus,
  canonicalizeStructuredReferences,
  parseDiscussionDispatch,
  parseStructuredOutput,
  resolveDiscussionConfiguration,
  validateDecisionProvenance,
  validateModerationPlan,
  validateRevisionMemo,
} from "./discussion-protocol.js";
import {
  DISCUSSION_FINAL_STATUSES,
  DISCUSSION_LEASE_HEARTBEAT_MS,
  acquireDiscussionLease,
  appendDiscussionEvent,
  assertDiscussionLease,
  cleanupExpiredDiscussions,
  createDiscussionRecord,
  discussionArtifacts,
  discussionEventsPage,
  discussionExpiresAt,
  heartbeatDiscussionLease,
  listDiscussionStates,
  listNonTerminalDiscussions,
  markDiscussionUnknown,
  readDiscussionArtifact,
  readDiscussionEvents,
  readDiscussionRequest,
  readDiscussionState,
  recoverDiscussionRecord,
  releaseDiscussionLease,
  removeDiscussionRecord,
  writeDiscussionArtifact,
} from "./discussion-store.js";
import {
  freezeHandoff,
  freezeMaterials,
  loadMaterialContext,
} from "./discussion-materials.js";
import { buildDiscussionPrompt, buildFormatRepairPrompt } from "./discussion-prompts.js";
import { renderDecisionMarkdown } from "./discussion-render.js";
import { claimSessionLineage } from "./session-registry.js";
import { cleanupExpiredRuns } from "./fs-store.js";
import { POLL_AFTER_MS } from "./timing.js";
import {
  completionQuality,
  discussionListResult,
  enrichTerminalError,
  failureSummary,
  phaseStatistics,
  progressFromState,
} from "./discussion-observability.js";
import {
  DEFAULT_DISCUSSION_BUDGET_PROFILE,
  discussionAbsoluteDeadlines,
  discussionBudgetStatus,
  discussionPhaseDeadline,
  hasRepairBudget,
  inheritedDiscussionBudgetProfile,
  resolveDiscussionBudget,
} from "./discussion-budget.js";

const PUBLIC_EVENT_TYPES = new Set([
  "participant.memo.accepted",
  "moderation.plan.accepted",
  "challenge.response.accepted",
  "participant.revision.accepted",
  "external_evidence.recorded",
  "external_evidence.status_changed",
]);
const LEGACY_PHASES = Object.freeze({
  independent: 10 * 60 * 1000,
  moderating: 3 * 60 * 1000,
  challenge: 6 * 60 * 1000,
  revision: 6 * 60 * 1000,
  synthesizing: 5 * 60 * 1000,
});
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "unknown"]);

export class DiscussionManager {
  constructor(options = {}) {
    this.ownerId = options.owner_id ?? crypto.randomUUID();
    this.now = options.now ?? (() => Date.now());
    this.phaseDurations = { ...LEGACY_PHASES, ...(options.phase_durations_ms ?? {}) };
    this.phaseDurationsOverride = options.phase_durations_ms ? this.phaseDurations : null;
    this.budgetOverride = options.budget_override ?? null;
    this.pollIntervalMs = options.poll_interval_ms ?? POLL_AFTER_MS;
    this.waitWindowMs = options.wait_window_ms ?? DEFAULT_WAIT_MS;
    this.autoResume = options.auto_resume ?? true;
    this.logDiagnostic = options.log_diagnostic ?? ((diagnostic) => {
      process.stderr.write(`discussion ${diagnostic.event}: ${diagnostic.error.message}\n`);
    });
    this.runApi = {
      dispatch: options.run_api?.dispatch ?? dispatchToAgent,
      query: options.run_api?.query ?? queryAgentRunSnapshot,
      cancel: options.run_api?.cancel ?? cancelAgentRun,
      retain: options.run_api?.retain ?? retainAgentRun,
    };
    this.controllers = new Map();
    this.leases = new Map();
    this.heartbeatTimers = new Map();
    this.shuttingDown = false;
    this.cleanupTimer = null;
  }

  async start(options = {}) {
    await Promise.all([cleanupExpiredDiscussions(), cleanupExpiredRuns()]);
    if (options.recover_existing !== false) {
      const ids = await listNonTerminalDiscussions();
      for (const id of ids) {
        try {
          const state = await recoverDiscussionRecord(id);
          if (state.preflight_complete) this.ensureRunning(id);
          else await removeDiscussionRecord(id);
        } catch (error) {
          await markDiscussionUnknown(id, error).catch(() => undefined);
        }
      }
    }
    this.cleanupTimer = setInterval(() => {
      Promise.all([cleanupExpiredDiscussions(), cleanupExpiredRuns()]).catch((error) => {
        this.logDiagnostic({
          event: "cleanup_failed",
          error: publicError(error),
        });
      });
    }, 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    const controllers = Array.from(this.controllers.values());
    await Promise.allSettled(controllers);
    for (const [id, lease] of this.leases) {
      await releaseDiscussionLease(id, lease).catch(() => undefined);
    }
  }

  async dispatch(rawInput) {
    if (this.shuttingDown) throw codedError("daemon_shutting_down", "Discussion daemon is shutting down");
    const input = parseDiscussionDispatch(rawInput);
    return input.kind === "new" ? this.dispatchNew(input) : this.dispatchFollowUp(input);
  }

  async dispatchNew(input) {
    const id = crypto.randomUUID();
    const prepared = await this.prepareRoster(input.cwd, input.host, input.participants);
    const initial = initialDiscussionState(id, input, prepared, this.now());
    await createDiscussionRecord(initial, {
      ...input,
      cwd: prepared.cwd,
      host: prepared.host.request,
      participants: prepared.participants.map((item) => item.request),
    });
    try {
      const manifest = await freezeMaterials(id, prepared.cwd, input.materials);
      await this.finishPreflight(id, manifest, null);
    } catch (error) {
      await removeDiscussionRecord(id).catch(() => undefined);
      throw error;
    }
    this.ensureRunning(id);
    return acceptedDiscussion(id);
  }

  async dispatchFollowUp(input) {
    const parentId = input.parent_discussion_ref.discussion_id;
    const parent = await readDiscussionState(parentId);
    const parentExpiresAt = Date.parse(parent.expires_at ?? "");
    if (
      parent.status !== "completed" ||
      !parent.results?.decision_record ||
      !Number.isFinite(parentExpiresAt) ||
      parentExpiresAt <= this.now()
    ) {
      throw codedError("invalid_follow_up_parent", "Follow-up parent must be unexpired and completed");
    }
    const parentRequest = await readDiscussionRequest(parentId);
    const parentMaterialIds = new Set(
      (parent.material_manifest?.items ?? []).map((item) => item.material_id),
    );
    for (const material of input.materials) {
      if (parentMaterialIds.has(material.material_id)) {
        throw codedError(
          "invalid_follow_up_material",
          `Follow-up material_id already exists in parent: ${material.material_id}`,
        );
      }
    }
    const inherited = {
      kind: "follow_up",
      objective: parent.objective,
      question: input.question,
      cwd: parent.cwd,
      materials: input.materials,
      host: parentRequest.host,
      participants: parentRequest.participants,
      quorum: parent.quorum,
      budget_profile: inheritedDiscussionBudgetProfile(parent),
      parent_discussion_ref: input.parent_discussion_ref,
    };
    const id = crypto.randomUUID();
    const prepared = await this.prepareRoster(inherited.cwd, inherited.host, inherited.participants);
    const parentEvents = (await readDiscussionEvents(parentId)).events
      .filter((event) => PUBLIC_EVENT_TYPES.has(event.type) || event.type === "decision.accepted")
      .map(publicEvent);
    const handoff = {
      schema_version: 1,
      parent_discussion_ref: input.parent_discussion_ref,
      objective: parent.objective,
      question: parent.question,
      decision: parent.results.decision_record,
      material_manifest: parent.material_manifest,
      events: parentEvents,
      roster: {
        host: publicHandoffMember(parent.members.host),
        participants: Object.fromEntries(
          Object.entries(parent.members.participants).map(([memberId, member]) => [
            memberId,
            publicHandoffMember(member),
          ]),
        ),
      },
    };
    const initial = initialDiscussionState(id, inherited, prepared, this.now());
    await createDiscussionRecord(initial, {
      ...inherited,
      host: prepared.host.request,
      participants: prepared.participants.map((item) => item.request),
    });
    try {
      const manifest = await freezeMaterials(id, prepared.cwd, input.materials);
      await freezeHandoff(id, handoff);
      const resumed = await this.claimParentSessions(id, parent);
      await this.finishPreflight(id, manifest, handoff, resumed);
    } catch (error) {
      await removeDiscussionRecord(id).catch(() => undefined);
      throw error;
    }
    this.ensureRunning(id);
    return acceptedDiscussion(id);
  }

  async resume(id) {
    if (this.shuttingDown) {
      throw codedError("daemon_shutting_down", "Discussion controller is shutting down");
    }
    const state = await recoverDiscussionRecord(id);
    if (!DISCUSSION_FINAL_STATUSES.has(state.status) && state.preflight_complete) {
      this.ensureRunning(id);
    }
    return state;
  }

  async waitForController(id) {
    const state = await readDiscussionState(id);
    if (DISCUSSION_FINAL_STATUSES.has(state.status)) return state;
    const controller = this.ensureRunning(id);
    if (controller) await controller;
    return readDiscussionState(id);
  }

  async query(input) {
    const id = input?.discussion_ref?.discussion_id;
    let state;
    let page;
    let events;
    try {
      state = await readDiscussionState(id);
      ({ events } = await readDiscussionEvents(id));
      page = await discussionEventsPage(id, input ?? {}, events);
    } catch (error) {
      if (error?.code === "unknown_discussion") throw error;
      try {
        state = await recoverDiscussionRecord(id);
        ({ events } = await readDiscussionEvents(id));
        page = await discussionEventsPage(id, input ?? {}, events);
      } catch (recoveryError) {
        state = await markDiscussionUnknown(id, recoveryError);
        events = [];
        page = {
          events: [],
          next_sequence: state.committed_event_sequence ?? 0,
          has_more: false,
        };
      }
    }
    if (
      this.autoResume &&
      !DISCUSSION_FINAL_STATUSES.has(state.status) &&
      state.preflight_complete
    ) {
      this.ensureRunning(id);
    }
    const artifacts = await discussionArtifacts(id);
    const failure = failureSummary(state);
    const response = {
      schema_version: state.schema_version,
      protocol_version: state.protocol_version,
      status: state.status,
      phase: state.phase,
      discussion_ref: { discussion_id: id },
      parent_discussion_ref: state.parent_discussion_ref,
      objective: state.objective,
      question: state.question,
      cwd: state.cwd,
      quorum: state.quorum,
      protocol_integrity: state.protocol_integrity,
      conclusion_strength: state.conclusion_strength,
      completion_quality: completionQuality(state),
      budget_status: discussionBudgetStatus(state, this.now()),
      progress: progressFromState(state),
      phase_statistics: phaseStatistics(state, events),
      failure_summary: failure,
      host_status: publicMember(state.members?.host),
      participant_statuses: Object.values(state.members?.participants ?? {}).map(publicMember),
      effective_configurations: [
        publicConfiguration(state.members?.host),
        ...Object.values(state.members?.participants ?? {}).map(publicConfiguration),
      ],
      best_effort_read_only: true,
      active_run_refs: state.active_run_refs ?? [],
      recent_events: page.events.map(publicEvent),
      next_sequence: page.next_sequence,
      has_more: page.has_more,
      started_at: state.started_at,
      accepted_at: state.accepted_at,
      completed_at: state.completed_at,
      expires_at: state.expires_at,
      deadline_at: state.deadline_at,
      phase_deadline_at: state.phase_deadline_at,
      cancellation_requested: state.cancellation_requested,
      artifacts,
      error: enrichTerminalError(state.error, failure),
      poll_after_ms: POLL_AFTER_MS,
    };
    if (state.status === "completed") {
      response.decision = state.results.decision_record;
      response.content = (await readDiscussionArtifact(id, "decision.md")) ?? "";
      response.run_refs = state.run_refs ?? [];
    } else if (DISCUSSION_FINAL_STATUSES.has(state.status)) {
      response.run_refs = state.run_refs ?? [];
    }
    return response;
  }

  async list(input = {}) {
    const { states, source_errors: sourceErrors } = await listDiscussionStates();
    return discussionListResult(states, sourceErrors, input, this.now());
  }

  async wait(input) {
    const deadline = this.now() + this.waitWindowMs;
    let snapshot = await this.query(input);
    while (!DISCUSSION_FINAL_STATUSES.has(snapshot.status) && this.now() < deadline) {
      if (this.shuttingDown) return { ...snapshot, timed_out: true };
      await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - this.now())));
      snapshot = await this.query(input);
    }
    if (!DISCUSSION_FINAL_STATUSES.has(snapshot.status)) return { ...snapshot, timed_out: true };
    return snapshot;
  }

  async cancel(input) {
    const id = input?.discussion_ref?.discussion_id;
    const state = await readDiscussionState(id);
    if (DISCUSSION_FINAL_STATUSES.has(state.status)) return this.query(input);
    await appendDiscussionEvent(
      id,
      "discussion.cancel_requested",
      { reason: input?.reason ?? null, actor: input?.actor ?? "caller" },
      (current) => ({ ...current, cancellation_requested: true }),
      { skip_lease: true },
    );
    const latest = await readDiscussionState(id);
    await Promise.allSettled(
      (latest.active_run_refs ?? []).map((runRef) =>
        this.runApi.cancel({
          run_ref: runRef,
          reason: input?.reason ?? "discussion cancelled",
          actor: input?.actor ?? "discussion",
        }),
      ),
    );
    if (this.autoResume) this.ensureRunning(id);
    return this.query(input);
  }

  ensureRunning(id) {
    if (this.shuttingDown || this.controllers.has(id)) return this.controllers.get(id);
    const task = this.runController(id)
      .catch(async (error) => {
        if (
          error?.code === "discussion_lease_held" ||
          error?.code === "discussion_lease_lost" ||
          error?.code === "daemon_shutting_down"
        ) return;
        await this.failDiscussion(id, error, this.leases.get(id)).catch(() => undefined);
      })
      .finally(async () => {
        const lease = this.leases.get(id);
        const timer = this.heartbeatTimers.get(id);
        if (timer) clearInterval(timer);
        if (lease) await releaseDiscussionLease(id, lease).catch(() => undefined);
        this.leases.delete(id);
        this.heartbeatTimers.delete(id);
        this.controllers.delete(id);
      });
    this.controllers.set(id, task);
    return task;
  }

  async runController(id) {
    const lease = await acquireDiscussionLease(id, this.ownerId);
    this.leases.set(id, lease);
    const timer = setInterval(() => {
      heartbeatDiscussionLease(id, lease)
        .then((renewed) => this.leases.set(id, renewed))
        .catch(() => clearInterval(timer));
    }, DISCUSSION_LEASE_HEARTBEAT_MS);
    timer.unref();
    this.heartbeatTimers.set(id, timer);

    let state = await readDiscussionState(id);
    if (DISCUSSION_FINAL_STATUSES.has(state.status) || !state.preflight_complete) return;
    if (state.status === "queued") {
      ({ state } = await this.commit(id, "discussion.started", {}, (current) => ({
        ...current,
        status: "running",
        started_at: current.started_at ?? iso(this.now()),
      })));
    }
    if (state.cancellation_requested) return this.finalizeCancelled(id);

    await this.runParticipantPhase(id, "independent", "participant_memo");
    state = await readDiscussionState(id);
    if (state.cancellation_requested) return this.finalizeCancelled(id);
    const effectiveIds = effectiveParticipantIds(state);
    if (effectiveIds.length < state.quorum) {
      throw codedError("quorum_not_met", `Only ${effectiveIds.length} valid memos for quorum ${state.quorum}`);
    }

    await this.runHostTurn(id, "moderating", "moderation_plan");
    state = await readDiscussionState(id);
    if (!state.results.moderation_plan) throw codedError("moderation_failed", "Host did not produce a ModerationPlan");
    if (state.cancellation_requested) return this.finalizeCancelled(id);

    await this.runParticipantPhase(id, "challenge", "challenge_response", effectiveIds);
    state = await readDiscussionState(id);
    if (state.cancellation_requested) return this.finalizeCancelled(id);

    await this.runParticipantPhase(id, "revision", "revision_memo", effectiveIds);
    state = await readDiscussionState(id);
    if (state.cancellation_requested) return this.finalizeCancelled(id);

    await this.runHostTurn(id, "synthesizing", "decision_record");
    state = await readDiscussionState(id);
    if (!state.results.decision_record) throw codedError("decision_failed", "Host did not produce a DecisionRecord");
    await this.finalizeCompleted(id);
  }

  async runParticipantPhase(id, phase, kind, explicitIds) {
    let state = await readDiscussionState(id);
    const ids = explicitIds ?? Object.keys(state.members.participants);
    const pending = ids.filter((participantId) => !turnFinished(state, participantId, kind));
    if (pending.length === 0) return;
    await this.enterPhase(id, phase);
    await Promise.all(
      pending.map((participantId) =>
        this.executeTurn(id, participantId, kind).catch((error) => {
          rethrowControllerExit(error);
          return this.markTurnFailed(id, participantId, kind, error);
        }),
      ),
    );
  }

  async runHostTurn(id, phase, kind) {
    const state = await readDiscussionState(id);
    if (turnFinished(state, "host", kind)) return;
    await this.enterPhase(id, phase);
    try {
      await this.executeTurn(id, "host", kind);
    } catch (error) {
      rethrowControllerExit(error);
      await this.markTurnFailed(id, "host", kind, error);
    }
  }

  async enterPhase(id, phase) {
    const state = await readDiscussionState(id);
    if (state.phase === phase && state.phase_deadline_at) return state;
    const started = this.now();
    const absolute = Date.parse(state.phase_absolute_deadlines[phase]);
    const deadline = state.budget
      ? discussionPhaseDeadline(started, phase, absolute, state.budget)
      : Math.min(started + this.phaseDurations[phase], absolute);
    return this.commit(id, "phase.started", { phase, deadline_at: iso(deadline) }, (current) => ({
      ...current,
      phase,
      phase_started_at: iso(started),
      phase_deadline_at: iso(deadline),
    })).then((result) => result.state);
  }

  async executeTurn(id, memberId, kind) {
    let state = await readDiscussionState(id);
    if (turnFinished(state, memberId, kind)) return turnResult(state, memberId, kind);
    let member = getMember(state, memberId);
    let repairError = null;
    let retryWithNewSession = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      state = await readDiscussionState(id);
      if (state.cancellation_requested) throw codedError("discussion_cancelled", "Discussion was cancelled");
      if (this.shuttingDown) throw codedError("daemon_shutting_down", "Daemon is shutting down");
      const phaseDeadline = Date.parse(state.phase_deadline_at);
      if (this.now() >= phaseDeadline) throw codedError("turn_deadline", `${kind} phase deadline reached`);
      member = getMember(state, memberId);
      const attemptKey = `${kind}:${memberId}:${attempt}`;
      let attemptState = state.turn_attempts?.[attemptKey];
      if (attemptState?.status === "skipped") {
        throw codedError(attemptState.error.code, attemptState.error.message);
      }
      let sessionRef = null;
      let expectedGeneration;
      let claimId;
      if (!retryWithNewSession && member.session_health === "healthy") {
        sessionRef = member.cli_session_ref;
        expectedGeneration = member.session_generation;
        claimId = member.session_claim_id;
      }
      if (repairError && attemptState?.session_ref) {
        sessionRef = attemptState.session_ref;
        expectedGeneration = attemptState.session_generation;
      }

      const promptPath = `prompts/${safeTurnFile(kind, memberId)}.attempt-${attempt}.txt`;
      let prompt = await readDiscussionArtifact(id, promptPath);
      if (prompt === null) {
        if (repairError) {
          const replayPrompt = sessionRef
            ? null
            : await readDiscussionArtifact(
                id,
                `prompts/${safeTurnFile(kind, memberId)}.attempt-1.txt`,
              );
          prompt = buildFormatRepairPrompt(
            kind,
            repairError,
            member.configuration.max_prompt_bytes,
            replayPrompt,
          );
        } else {
          prompt = await this.renderTurnPrompt(id, memberId, kind, Boolean(sessionRef));
        }
        await writeDiscussionArtifact(id, promptPath, prompt);
      }
      const promptSha256 = sha256Text(prompt);
      const idempotencyKey = `discussion:${id}:turn:${kind}:${memberId}:attempt:${attempt}`;
      const requestHash = sha256Json({
        input: {
          agent_id: member.agent_id,
          prompt,
          cwd: state.cwd,
          cli_session_ref: sessionRef,
          metadata: member.configuration.effective_metadata,
        },
        expected_session_generation: expectedGeneration ?? null,
        session_claim_id: claimId ?? null,
      });
      if (!attemptState) {
        ({ state } = await this.commit(
          id,
          "turn.dispatch_requested",
          {
            turn_id: `${kind}:${memberId}`,
            member_id: memberId,
            kind,
            attempt,
            prompt_sha256: promptSha256,
            idempotency_key: idempotencyKey,
            request_hash: requestHash,
          },
          (current) => ({
            ...assertDispatchAllowed(current),
            turn_attempts: {
              ...(current.turn_attempts ?? {}),
              [attemptKey]: {
                status: "requested",
                prompt_path: promptPath,
                prompt_sha256: promptSha256,
                idempotency_key: idempotencyKey,
                request_hash: requestHash,
                session_ref: sessionRef,
                session_generation: expectedGeneration,
                phase_deadline_at: state.phase_deadline_at,
                remaining_ms_at_dispatch: Math.max(0, phaseDeadline - this.now()),
                requested_at: iso(this.now()),
              },
            },
          }),
        ));
        attemptState = state.turn_attempts[attemptKey];
      }

      let runRef = attemptState.run_ref;
      let accepted;
      if (!runRef && repairError && !hasRepairBudget(state, this.now())) {
        const remaining = Math.max(0, phaseDeadline - this.now());
        const minimum = state.budget?.repair_min_ms ?? 0;
        const error = {
          code: "repair_budget_exhausted",
          message: `${kind} repair needs ${minimum}ms but only ${remaining}ms remain`,
        };
        await this.skipAttempt(id, attemptKey, memberId, kind, attempt, error, remaining);
        throw codedError(error.code, error.message);
      }
      if (!runRef) {
        if (this.shuttingDown) {
          throw codedError("daemon_shutting_down", "Daemon is shutting down");
        }
        const dispatchLease = this.leases.get(id);
        if (!dispatchLease) {
          throw codedError("discussion_lease_lost", "Discussion controller has no active lease");
        }
        await assertDiscussionLease(id, dispatchLease);
        try {
          accepted = await this.runApi.dispatch(
            {
              agent_id: member.agent_id,
              prompt,
              cwd: state.cwd,
              cli_session_ref: attemptState.session_ref ?? null,
              metadata: member.configuration.effective_metadata,
            },
            {
              idempotency_key: attemptState.idempotency_key,
              expected_session_generation: attemptState.session_generation,
              session_claim_id: claimId,
              retain_until: state.deadline_at,
              retained_by_discussion: id,
            },
          );
        } catch (error) {
          if (attempt === 1 && sessionRef && isSessionResumeFailure(error)) {
            await this.finishAttempt(id, attemptKey, null, "failed", publicError(error));
            repairError = null;
            retryWithNewSession = true;
            continue;
          }
          throw error;
        }
        runRef = accepted.run_ref;
        await this.runApi.retain(runRef, id, state.deadline_at);
        await this.commit(
          id,
          "turn.dispatched",
          { member_id: memberId, kind, attempt, run_ref: runRef },
          (current) => {
            const active = uniqueRunRefs([...(current.active_run_refs ?? []), runRef]);
            const all = uniqueRunRefs([...(current.run_refs ?? []), runRef]);
            return {
              ...current,
              active_run_refs: active,
              run_refs: all,
              turn_attempts: {
                ...current.turn_attempts,
                [attemptKey]: {
                  ...current.turn_attempts[attemptKey],
                  status: "running",
                  run_ref: runRef,
                  session_ref: accepted.cli_session_ref ?? attemptState.session_ref,
                  session_generation:
                    accepted.session_generation ?? attemptState.session_generation,
                  dispatched_at: iso(this.now()),
                },
              },
            };
          },
        );
      } else {
        await this.runApi.retain(runRef, id, state.deadline_at);
      }

      const cancellationState = await readDiscussionState(id);
      if (cancellationState.cancellation_requested) {
        await this.runApi.cancel({ run_ref: runRef, reason: "discussion cancelled", actor: "discussion" });
      }
      const snapshot = await this.waitForRun(runRef, phaseDeadline);
      const completedAt = Date.parse(snapshot.completed_at ?? "");
      if (
        snapshot.status === "completed" &&
        (!Number.isFinite(completedAt) || completedAt > phaseDeadline)
      ) {
        await this.finishAttempt(id, attemptKey, runRef, "late", {
          code: "turn_late",
          message: `${kind} completed after its phase deadline`,
        });
        throw codedError("turn_late", `${kind} completed after its phase deadline`);
      }

      if (snapshot.status === "completed") {
        try {
          let output = parseStructuredOutput(kind, snapshot.content?.[0]?.text ?? "");
          output = await this.validateTurnOutput(id, memberId, kind, output);
          await this.acceptTurn(id, memberId, kind, attemptKey, runRef, snapshot, output);
          return output;
        } catch (error) {
          await this.finishAttempt(id, attemptKey, runRef, "failed", {
            code: "structured_output_invalid",
            message: error.message,
          });
          if (attempt === 1) {
            repairError = error.message;
            retryWithNewSession = false;
            const latest = await readDiscussionState(id);
            await this.updateMemberSession(id, memberId, {
              cli_session_ref: member.configuration.session_resume
                ? snapshot.cli_session_ref
                : null,
              session_generation: member.configuration.session_resume
                ? snapshot.session_generation
                : undefined,
              session_health:
                member.configuration.session_resume && snapshot.cli_session_ref
                  ? "healthy"
                  : "none",
            }, latest);
            continue;
          }
          throw error;
        }
      }

      await this.finishAttempt(id, attemptKey, runRef, "failed", snapshot.error ?? {
        code: snapshot.status,
        message: snapshot.content?.[0]?.text ?? `Run ${snapshot.status}`,
      });
      if (attempt === 1 && (snapshot.retryable || isSessionResumeFailure(snapshot))) {
        repairError = null;
        retryWithNewSession = true;
        continue;
      }
      throw codedError(snapshot.error?.code ?? "turn_failed", snapshot.error?.message ?? `Run ${snapshot.status}`);
    }
    throw codedError("turn_failed", `${kind} exhausted attempts`);
  }

  async waitForRun(runRef, deadline) {
    let snapshot = await this.runApi.query({ run_ref: runRef });
    while (!TERMINAL_RUN_STATUSES.has(snapshot.status)) {
      if (this.shuttingDown) {
        throw codedError("daemon_shutting_down", "Daemon is shutting down");
      }
      if (this.now() >= deadline) {
        await this.runApi.cancel({ run_ref: runRef, reason: "discussion phase deadline", actor: "discussion" });
        const cancelled = await this.runApi.query({ run_ref: runRef });
        if (cancelled.status !== "cancelled" || cancelled.error) return cancelled;
        return {
          ...cancelled,
          error: {
            code: "turn_deadline",
            message: "Discussion turn exceeded its phase deadline",
          },
          retryable: false,
        };
      }
      await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - this.now())));
      snapshot = await this.runApi.query({ run_ref: runRef });
    }
    return snapshot;
  }

  async validateTurnOutput(id, memberId, kind, output) {
    const state = await readDiscussionState(id);
    const allowedRefs = await this.allowedProvenanceRefs(id, state, memberId);
    output = canonicalizeStructuredReferences(output, allowedRefs);
    validateEvidenceAdditions(output, state.evidence);
    for (const evidence of [...(output.external_evidence ?? []), ...(output.evidence_added ?? [])]) {
      allowedRefs.add(`external:${evidence.evidence_id}`);
    }
    if (kind === "moderation_plan") {
      validateClaimReferences(
        output.assignments.flatMap((item) => item.related_claim_refs),
        allowedRefs,
      );
      return validateModerationPlan(output, effectiveParticipantIds(state));
    }
    if (kind === "participant_memo") {
      validateClaimIds(output.claims);
    }
    if (kind === "challenge_response") {
      const assignment = state.results.moderation_plan.assignments.find(
        (item) => item.participant_id === memberId,
      );
      if (!assignment || output.assignment_id !== assignment.assignment_id) {
        throw codedError("structured_output_invalid", "ChallengeResponse assignment_id mismatch");
      }
      validateClaimReferences(output.tested_claim_refs, allowedRefs);
      validateEvidenceVerdicts(output.evidence_verdicts, allowedRefs);
    }
    if (kind === "revision_memo") {
      validateReferences(collectEvidenceRefs(output), allowedRefs);
      validateClaimIds(output.new_claims, state.results.participant_memos[memberId]?.claims ?? []);
      return validateRevisionMemo(output, state.results.participant_memos[memberId]);
    }
    if (kind === "decision_record") {
      validateDecisionEvidenceStatuses(output, state.evidence);
      return validateDecisionProvenance(output, allowedRefs);
    }
    validateReferences(collectEvidenceRefs(output), allowedRefs);
    return output;
  }

  async acceptTurn(id, memberId, kind, attemptKey, runRef, snapshot, output) {
    const eventType = {
      participant_memo: "participant.memo.accepted",
      moderation_plan: "moderation.plan.accepted",
      challenge_response: "challenge.response.accepted",
      revision_memo: "participant.revision.accepted",
      decision_record: "decision.accepted",
    }[kind];
    await this.commit(id, eventType, { member_id: memberId, kind, output, run_ref: runRef }, (current) => {
      const next = structuredClone(current);
      const member = getMember(next, memberId);
      member.turns = {
        ...(member.turns ?? {}),
        [kind]: { status: "accepted", result: output, run_ref: runRef },
      };
      member.formal_turns_completed = (member.formal_turns_completed ?? 0) + 1;
      member.cli_session_ref = member.configuration.session_resume
        ? snapshot.cli_session_ref ?? member.cli_session_ref
        : null;
      member.session_generation = member.configuration.session_resume
        ? snapshot.session_generation ?? member.session_generation
        : undefined;
      member.session_health = member.cli_session_ref ? "healthy" : "none";
      member.session_claim_id = null;
      member.last_seen_event_sequence = (current.committed_event_sequence ?? 0) + 1;
      setMember(next, memberId, member);
      next.active_run_refs = removeRunRef(next.active_run_refs, runRef);
      next.turn_attempts[attemptKey] = {
        ...next.turn_attempts[attemptKey],
        status: "completed",
        completed_at: snapshot.completed_at,
      };
      if (kind === "participant_memo") next.results.participant_memos[memberId] = output;
      if (kind === "moderation_plan") next.results.moderation_plan = output;
      if (kind === "challenge_response") next.results.challenge_responses[memberId] = output;
      if (kind === "revision_memo") next.results.revision_memos[memberId] = output;
      if (kind === "decision_record") {
        next.results.decision_record = output;
        next.conclusion_strength = output.conclusion_strength;
      }
      incorporateEvidence(next, memberId, kind, output);
      return next;
    });
  }

  async finishAttempt(id, attemptKey, runRef, status, error) {
    const eventType = status === "late" ? "turn.late" : "turn.failed";
    await this.commit(id, eventType, { attempt_key: attemptKey, run_ref: runRef, error }, (current) => ({
      ...current,
      active_run_refs: removeRunRef(current.active_run_refs, runRef),
      turn_attempts: {
        ...current.turn_attempts,
        [attemptKey]: {
          ...current.turn_attempts[attemptKey],
          status,
          error,
          completed_at: iso(this.now()),
        },
      },
    }));
  }

  async skipAttempt(id, attemptKey, memberId, kind, attempt, error, remainingMs) {
    const timestamp = iso(this.now());
    await this.commit(
      id,
      "turn.skipped",
      { member_id: memberId, kind, attempt, error },
      (current) => ({
        ...current,
        turn_attempts: {
          ...(current.turn_attempts ?? {}),
          [attemptKey]: {
            ...(current.turn_attempts?.[attemptKey] ?? {}),
            status: "skipped",
            error,
            phase_deadline_at: current.phase_deadline_at,
            remaining_ms_when_skipped: remainingMs,
            requested_at: current.turn_attempts?.[attemptKey]?.requested_at ?? timestamp,
            completed_at: timestamp,
          },
        },
      }),
    );
  }

  async markTurnFailed(id, memberId, kind, error) {
    const state = await readDiscussionState(id);
    if (turnFinished(state, memberId, kind)) return;
    await this.commit(id, "turn.failed", { member_id: memberId, kind, error: publicError(error) }, (current) => {
      const next = structuredClone(current);
      const member = getMember(next, memberId);
      member.turns = {
        ...(member.turns ?? {}),
        [kind]: { status: "failed", error: publicError(error) },
      };
      if (member.cli_session_ref) member.session_health = "tainted";
      setMember(next, memberId, member);
      next.protocol_integrity = "degraded";
      return next;
    });
  }

  async updateMemberSession(id, memberId, patch, knownState) {
    if (knownState && DISCUSSION_FINAL_STATUSES.has(knownState.status)) return;
    await this.commit(id, "session.updated", { member_id: memberId }, (current) => {
      const next = structuredClone(current);
      const member = { ...getMember(next, memberId), ...patch };
      setMember(next, memberId, member);
      return next;
    });
  }

  async renderTurnPrompt(id, memberId, kind, usingSession) {
    const state = await readDiscussionState(id);
    const member = getMember(state, memberId);
    const materials = await loadMaterialContext(id, state.material_manifest);
    const { events } = await readDiscussionEvents(id);
    const since = usingSession ? member.last_seen_event_sequence ?? 0 : 0;
    const publicEvents = events
      .filter((event) => event.sequence > since && PUBLIC_EVENT_TYPES.has(event.type))
      .map(publicEvent);
    const handoffText = state.parent_discussion_ref
      ? await readDiscussionArtifact(id, "handoff/context.json")
      : null;
    const handoff = handoffText ? JSON.parse(handoffText) : null;
    const visibleHandoff =
      memberId === "host" || !handoff ? handoff : participantHandoff(handoff, memberId);
    const materialInput = usingSession && member.last_seen_event_sequence
      ? { manifest: materials.manifest }
      : materials;
    return buildDiscussionPrompt({
      kind,
      role:
        memberId === "host"
          ? { role: "host", focus: "moderate without voting or changing the roster" }
          : { role: member.role, focus: member.focus },
      objective: state.objective,
      question: state.question,
      materials: materialInput,
      events: publicEvents,
      turn_input: turnInputFor(kind, memberId, state, usingSession ? null : visibleHandoff),
      max_prompt_bytes: member.configuration.max_prompt_bytes,
    });
  }

  async allowedProvenanceRefs(id, state, memberId = "host") {
    const refs = new Set((state.material_manifest?.items ?? []).map((item) => `material:${item.material_id}`));
    for (const evidenceId of Object.keys(state.evidence ?? {})) refs.add(`external:${evidenceId}`);
    const { events } = await readDiscussionEvents(id);
    for (const event of events) {
      if (!PUBLIC_EVENT_TYPES.has(event.type)) continue;
      addEventReferences(refs, event);
    }
    if (state.parent_discussion_ref) {
      const handoffText = await readDiscussionArtifact(id, "handoff/context.json");
      if (handoffText) {
        const handoff = JSON.parse(handoffText);
        const visible = memberId === "host" ? handoff : participantHandoff(handoff, memberId);
        for (const item of visible.material_manifest?.items ?? []) {
          refs.add(`material:${item.material_id}`);
        }
        for (const event of visible.events ?? []) {
          addEventReferences(refs, event);
          for (const evidence of [
            ...(event.payload?.output?.external_evidence ?? []),
            ...(event.payload?.output?.evidence_added ?? []),
          ]) {
            refs.add(`external:${evidence.evidence_id}`);
          }
        }
      }
    }
    return refs;
  }

  async enterTerminal(id, type, status, extra = {}) {
    const completedAt = iso(this.now());
    const expiresAt = discussionExpiresAt(new Date(completedAt));
    const { state } = await this.commit(id, type, extra, (current) => ({
      ...current,
      ...extra,
      status,
      completed_at: completedAt,
      expires_at: expiresAt,
      active_run_refs: [],
    }));
    await Promise.allSettled(
      (state.run_refs ?? []).map((runRef) => this.runApi.retain(runRef, id, expiresAt)),
    );
    return state;
  }

  async finalizeCompleted(id) {
    const state = await readDiscussionState(id);
    const decision = state.results.decision_record;
    const markdown = renderDecisionMarkdown(decision, {
      protocol_integrity: state.protocol_integrity,
      effective_configurations: [
        publicConfiguration(state.members.host),
        ...Object.values(state.members.participants).map(publicConfiguration),
      ],
    });
    await writeDiscussionArtifact(id, "decision.json", decision);
    await writeDiscussionArtifact(id, "decision.md", markdown);
    return this.enterTerminal(id, "discussion.completed", "completed", {
      conclusion_strength: decision.conclusion_strength,
    });
  }

  async finalizeCancelled(id) {
    const state = await readDiscussionState(id);
    await Promise.allSettled(
      (state.active_run_refs ?? []).map((runRef) =>
        this.runApi.cancel({ run_ref: runRef, reason: "discussion cancelled", actor: "discussion" }),
      ),
    );
    return this.enterTerminal(id, "discussion.cancelled", "cancelled");
  }

  async failDiscussion(id, error, lease) {
    const state = await readDiscussionState(id).catch(() => null);
    if (!state || DISCUSSION_FINAL_STATUSES.has(state.status)) return state;
    const failure = failureSummary(state, error);
    const terminalError = enrichTerminalError(error, failure);
    await Promise.allSettled(
      (state.active_run_refs ?? []).map((runRef) =>
        this.runApi.cancel({
          run_ref: runRef,
          reason: `discussion failed: ${error?.code ?? "discussion_error"}`,
          actor: "discussion",
        }),
      ),
    );
    return appendDiscussionEvent(
      id,
      "discussion.failed",
      { error: terminalError, failure_summary: failure },
      (current) => {
        const completedAt = iso(this.now());
        return {
          ...current,
          status: "failed",
          error: terminalError,
          failure_summary: failure,
          completed_at: completedAt,
          expires_at: discussionExpiresAt(new Date(completedAt)),
          active_run_refs: [],
        };
      },
      lease ? { lease } : { skip_lease: true },
    ).then(async (result) => {
      await Promise.allSettled(
        (result.state.run_refs ?? []).map((runRef) =>
          this.runApi.retain(runRef, id, result.state.expires_at),
        ),
      );
      return result.state;
    });
  }

  async prepareRoster(cwd, host, participants) {
    const preparedHost = await this.prepareMember(cwd, { ...host, member_id: "host" });
    const preparedParticipants = [];
    for (const participant of participants) {
      preparedParticipants.push(
        await this.prepareMember(cwd, { ...participant, member_id: participant.participant_id }),
      );
    }
    return { cwd: preparedHost.cwd, host: preparedHost, participants: preparedParticipants };
  }

  async prepareMember(cwd, member) {
    const adapter = getAdapter(member.agent_id);
    const availability = await adapter.getAvailability();
    if (!availability.available) {
      throw codedError("agent_unavailable", `${member.agent_id} is unavailable: ${availability.reason}`);
    }
    const configuration = resolveDiscussionConfiguration(member, adapter);
    const paths = await validateRequestPaths(cwd, configuration.effective_metadata, {
      metadataKey: adapter.metadataKey,
    });
    configuration.effective_metadata = {
      ...configuration.effective_metadata,
      [adapter.metadataKey]: {
        ...(configuration.effective_metadata[adapter.metadataKey] ?? {}),
        add_dirs: paths.addDirs,
      },
    };
    return {
      cwd: paths.cwd,
      request: {
        ...member,
        metadata: configuration.requested_metadata,
      },
      state: memberState(member, configuration),
    };
  }

  async finishPreflight(id, manifest, handoff, resumed = null) {
    const acceptedAt = this.now();
    const state = await readDiscussionState(id);
    const budget = this.budgetOverride
      ? structuredClone(this.budgetOverride)
      : resolveDiscussionBudget(
          state.budget_profile ?? DEFAULT_DISCUSSION_BUDGET_PROFILE,
          this.phaseDurationsOverride,
        );
    const deadlines = discussionAbsoluteDeadlines(acceptedAt, budget);
    await appendDiscussionEvent(
      id,
      "materials.frozen",
      { manifest, handoff: Boolean(handoff) },
      (current) => {
        const next = {
          ...current,
          material_manifest: manifest,
          handoff_present: Boolean(handoff),
          preflight_complete: true,
          accepted_at: iso(acceptedAt),
          deadline_at: deadlines.synthesizing,
          phase_absolute_deadlines: deadlines,
          budget,
        };
        if (resumed) next.members = resumed;
        return next;
      },
      { skip_lease: true },
    );
  }

  async claimParentSessions(id, parent) {
    const members = structuredClone((await readDiscussionState(id)).members);
    for (const memberId of ["host", ...Object.keys(members.participants)]) {
      const child = memberId === "host" ? members.host : members.participants[memberId];
      const source = getMember(parent, memberId);
      if (
        !child.configuration.session_resume ||
        !source?.cli_session_ref ||
        source.session_health !== "healthy"
      ) {
        child.session_mode = "rebuilt";
        continue;
      }
      const claimId = `discussion:${id}:member:${memberId}`;
      try {
        const record = await claimSessionLineage(source.cli_session_ref, {
          claim_id: claimId,
          expected_generation: source.session_generation ?? 0,
        });
        child.cli_session_ref = source.cli_session_ref;
        child.session_generation = record.generation;
        child.session_claim_id = claimId;
        child.session_health = "healthy";
        child.session_mode = "resumed";
      } catch {
        child.cli_session_ref = null;
        child.session_generation = undefined;
        child.session_claim_id = null;
        child.session_health = "none";
        child.session_mode = "rebuilt";
      }
    }
    return members;
  }

  commit(id, type, payload, mutate) {
    const lease = this.leases.get(id);
    return appendDiscussionEvent(id, type, payload, mutate, lease ? { lease } : { skip_lease: true });
  }
}

function initialDiscussionState(id, input, prepared, now) {
  return {
    schema_version: 1,
    protocol_version: 1,
    discussion_id: id,
    parent_discussion_ref: input.parent_discussion_ref ?? null,
    status: "queued",
    phase: "preparing",
    protocol_integrity: "complete",
    conclusion_strength: null,
    objective: input.objective,
    question: input.question,
    cwd: prepared.cwd,
    quorum: input.quorum,
    budget_profile: input.budget_profile ?? DEFAULT_DISCUSSION_BUDGET_PROFILE,
    members: {
      host: prepared.host.state,
      participants: Object.fromEntries(
        prepared.participants.map((item) => [item.state.member_id, item.state]),
      ),
    },
    results: {
      participant_memos: {},
      moderation_plan: null,
      challenge_responses: {},
      revision_memos: {},
      decision_record: null,
    },
    evidence: {},
    turn_attempts: {},
    active_run_refs: [],
    run_refs: [],
    cancellation_requested: false,
    preflight_complete: false,
    created_at: iso(now),
    updated_at: iso(now),
  };
}

function memberState(member, configuration) {
  return {
    member_id: member.member_id,
    participant_id: member.participant_id,
    agent_id: member.agent_id,
    role: member.role,
    focus: member.focus,
    configuration,
    cli_session_ref: null,
    session_generation: undefined,
    session_claim_id: null,
    session_health: "none",
    session_mode: "new",
    last_seen_event_sequence: 0,
    formal_turns_completed: 0,
    turns: {},
  };
}

function turnInputFor(kind, memberId, state, handoff) {
  if (kind === "participant_memo") return handoff ? { parent_handoff: handoff } : {};
  if (kind === "moderation_plan") {
    return {
      participant_ids: effectiveParticipantIds(state),
      participant_memos: state.results.participant_memos,
    };
  }
  if (kind === "challenge_response") {
    return {
      participant_memos: state.results.participant_memos,
      assignment: state.results.moderation_plan.assignments.find(
        (assignment) => assignment.participant_id === memberId,
      ),
    };
  }
  if (kind === "revision_memo") {
    return {
      original_claims: state.results.participant_memos[memberId]?.claims ?? [],
      challenge_responses: state.results.challenge_responses,
      evidence: state.evidence,
    };
  }
  return {
    participant_memos: state.results.participant_memos,
    moderation_plan: state.results.moderation_plan,
    challenge_responses: state.results.challenge_responses,
    revision_memos: state.results.revision_memos,
    evidence: state.evidence,
  };
}

function incorporateEvidence(state, memberId, kind, output) {
  const additions = [
    ...(output.external_evidence ?? []),
    ...(output.evidence_added ?? []),
  ];
  for (const evidence of additions) {
    state.evidence[evidence.evidence_id] = {
      ...evidence,
      reported_by: memberId,
      verdicts: state.evidence[evidence.evidence_id]?.verdicts ?? [],
      aggregate_status: "reported",
    };
  }
  if (kind === "challenge_response") {
    for (const verdict of output.evidence_verdicts) {
      const evidenceId = verdict.evidence_ref.replace(/^external:/, "");
      const evidence = state.evidence[evidenceId];
      if (!evidence) continue;
      evidence.verdicts.push({ ...verdict, participant_id: memberId });
      evidence.aggregate_status = aggregateEvidenceStatus(evidence.verdicts);
    }
  }
}

function addEventReferences(refs, event) {
  refs.add(`event:${event.sequence}`);
  for (const claim of event.payload?.output?.claims ?? []) {
    refs.add(`event:${event.sequence}#${claim.claim_id}`);
  }
  for (const claim of event.payload?.output?.new_claims ?? []) {
    refs.add(`event:${event.sequence}#${claim.claim_id}`);
  }
}

function validateEvidenceAdditions(output, existingEvidence) {
  const additions = [...(output.external_evidence ?? []), ...(output.evidence_added ?? [])];
  const seen = new Set();
  for (const evidence of additions) {
    if (seen.has(evidence.evidence_id) || existingEvidence?.[evidence.evidence_id]) {
      throw codedError(
        "structured_output_invalid",
        `Duplicate external evidence id: ${evidence.evidence_id}`,
      );
    }
    seen.add(evidence.evidence_id);
  }
}

function validateEvidenceVerdicts(verdicts, allowedRefs) {
  const seen = new Set();
  for (const verdict of verdicts) {
    if (!verdict.evidence_ref.startsWith("external:")) {
      throw codedError(
        "structured_output_invalid",
        `Evidence verdict must reference external evidence: ${verdict.evidence_ref}`,
      );
    }
    if (seen.has(verdict.evidence_ref)) {
      throw codedError(
        "structured_output_invalid",
        `Duplicate evidence verdict: ${verdict.evidence_ref}`,
      );
    }
    seen.add(verdict.evidence_ref);
    validateReferences([verdict.evidence_ref], allowedRefs);
  }
}

function validateDecisionEvidenceStatuses(decision, evidenceRegistry) {
  for (const item of decision.evidence) {
    const externalRefs = item.provenance.filter((ref) => ref.startsWith("external:"));
    for (const ref of externalRefs) {
      const evidence = evidenceRegistry?.[ref.slice("external:".length)];
      if (evidence && item.status !== evidence.aggregate_status) {
        throw codedError(
          "structured_output_invalid",
          `Decision evidence status for ${ref} must be ${evidence.aggregate_status}`,
        );
      }
    }
  }
}

function collectEvidenceRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  for (const [key, child] of Object.entries(value)) {
    if (key === "evidence_refs" && Array.isArray(child)) refs.push(...child);
    else collectEvidenceRefs(child, refs);
  }
  return refs;
}

function validateReferences(refs, allowedRefs) {
  for (const ref of refs) {
    if (!allowedRefs.has(ref)) {
      throw codedError("structured_output_invalid", `Unknown or unavailable reference: ${ref}`);
    }
  }
}

function validateClaimReferences(refs, allowedRefs) {
  for (const ref of refs) {
    if (!/^event:\d+#[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(ref)) {
      throw codedError("structured_output_invalid", `Expected a claim event reference: ${ref}`);
    }
  }
  validateReferences(refs, allowedRefs);
}

function validateClaimIds(claims, existingClaims = []) {
  const existing = new Set(existingClaims.map((claim) => claim.claim_id));
  const seen = new Set();
  for (const claim of claims) {
    if (seen.has(claim.claim_id) || existing.has(claim.claim_id)) {
      throw codedError("structured_output_invalid", `Duplicate claim_id: ${claim.claim_id}`);
    }
    seen.add(claim.claim_id);
  }
}

function rethrowControllerExit(error) {
  if (
    error?.code === "daemon_shutting_down" ||
    error?.code === "discussion_lease_lost" ||
    error?.code === "discussion_lease_held"
  ) {
    throw error;
  }
}

function isSessionResumeFailure(value) {
  const code = value?.error?.code ?? value?.code;
  return code === "session_resume_failed" || code === "session_resume_unavailable";
}

function assertDispatchAllowed(state) {
  if (state.cancellation_requested) {
    throw codedError("discussion_cancelled", "Discussion was cancelled");
  }
  if (DISCUSSION_FINAL_STATUSES.has(state.status)) {
    throw codedError("discussion_terminal", `Discussion is already ${state.status}`);
  }
  return state;
}

function effectiveParticipantIds(state) {
  return Object.keys(state.results.participant_memos ?? {});
}

function getMember(state, memberId) {
  return memberId === "host" ? state.members.host : state.members.participants[memberId];
}

function setMember(state, memberId, member) {
  if (memberId === "host") state.members.host = member;
  else state.members.participants[memberId] = member;
}

function turnFinished(state, memberId, kind) {
  return ["accepted", "failed"].includes(getMember(state, memberId)?.turns?.[kind]?.status);
}

function turnResult(state, memberId, kind) {
  return getMember(state, memberId)?.turns?.[kind]?.result ?? null;
}

function removeRunRef(refs = [], target) {
  if (!target?.run_id) return refs;
  return refs.filter((ref) => ref.run_id !== target.run_id);
}

function uniqueRunRefs(refs) {
  return Array.from(new Map(refs.map((ref) => [ref.run_id, ref])).values());
}

function publicEvent(event) {
  return {
    sequence: event.sequence,
    author: event.author,
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload,
  };
}

function publicMember(member) {
  if (!member) return null;
  return {
    member_id: member.member_id,
    participant_id: member.participant_id,
    agent_id: member.agent_id,
    role: member.role,
    focus: member.focus,
    permission: member.configuration.permission,
    network_access: member.configuration.network_access,
    session_health: member.session_health,
    session_mode: member.session_mode,
    formal_turns_completed: member.formal_turns_completed,
    turns: member.turns,
  };
}

function publicConfiguration(member) {
  if (!member) return null;
  return {
    member_id: member.member_id,
    agent_id: member.agent_id,
    permission: member.configuration.permission,
    network_access: member.configuration.network_access,
    max_prompt_bytes: member.configuration.max_prompt_bytes,
    session_mode: member.session_mode,
  };
}

function publicHandoffMember(member) {
  return {
    member_id: member.member_id,
    participant_id: member.participant_id,
    agent_id: member.agent_id,
    role: member.role,
    focus: member.focus,
  };
}

function participantHandoff(handoff, memberId) {
  const referencedSequences = new Set(
    collectHandoffRefs(handoff.decision)
      .map((ref) => ref.match(/^event:(\d+)/)?.[1])
      .filter(Boolean)
      .map(Number),
  );
  const events = [];
  for (const event of handoff.events ?? []) {
    if (referencedSequences.has(event.sequence) || event.payload?.member_id === memberId) {
      events.push(event);
      continue;
    }
    if (event.type === "moderation.plan.accepted") {
      const assignments = (event.payload?.output?.assignments ?? []).filter(
        (assignment) => assignment.participant_id === memberId,
      );
      if (assignments.length > 0) {
        events.push({
          ...event,
          payload: {
            member_id: "host",
            kind: "moderation_plan",
            output: {
              schema_version: 1,
              weakest_shared_assumption: event.payload.output.weakest_shared_assumption,
              assignments,
            },
          },
        });
      }
    }
  }
  return { ...handoff, events };
}

function collectHandoffRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectHandoffRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "provenance" || key === "evidence_refs") && Array.isArray(child)) {
      refs.push(...child);
    } else {
      collectHandoffRefs(child, refs);
    }
  }
  return refs;
}

function safeTurnFile(kind, memberId) {
  return `${kind}-${memberId}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function acceptedDiscussion(id) {
  return {
    status: "accepted",
    discussion_ref: { discussion_id: id },
    poll_after_ms: POLL_AFTER_MS,
  };
}

function publicError(error) {
  return {
    code: error?.code ?? "discussion_error",
    message: String(error?.message ?? error),
  };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Json(value) {
  return sha256Text(stableStringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

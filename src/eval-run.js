import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cancelAgentRun,
  dispatchToAgent,
  waitAgentRun,
} from "./runs.js";
import { getAdapter } from "./adapters.js";
import {
  CODEX_AGENT_ID,
  CODEX_EVAL_MIN_VERSION,
  supportsCodexEvalVersion,
} from "./codex-adapter.js";
import { projectLiveStream } from "./agent-session-core.js";
import { readTextIfExists, runDirFor } from "./fs-store.js";
import {
  EVAL_EXECUTION_PROFILE,
  SOURCE_LOCATION_GRADER_VERSION,
  answerDigest,
  buildEvalPrompt,
  cleanWorkspaceSnapshot,
  evalError,
  gradeSourceLocation,
  loadEvalSuite,
  normalizeExpectedSourceLocation,
  parseSourceLocationOutput,
  sameWorkspaceSnapshot,
} from "./eval-protocol.js";
import {
  cleanupExpiredEvalResults,
  evalExpiresAt,
  writeEvalResult,
} from "./eval-store.js";

const DEFAULT_CASE_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCE_LOCATION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["path", "symbol", "definition_line"],
  properties: {
    path: { type: "string", minLength: 1 },
    symbol: { type: "string", minLength: 1 },
    definition_line: { type: "integer", minimum: 1 },
  },
});

export async function runEval(input, io, internal = {}) {
  await cleanupExpiredEvalResults(internal.env ?? process.env);
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const suite = await loadEvalSuite(cwd, input.suite_path);
  const subject = await cleanWorkspaceSnapshot(cwd);
  const agent = await resolveEvalAgent(input, cwd, internal.env ?? process.env);
  const expected = await collectAnswers(suite, cwd, io);
  const afterAnswers = await cleanWorkspaceSnapshot(cwd);
  if (!sameWorkspaceSnapshot(subject, afterAnswers)) {
    throw evalError(
      "eval_workspace_changed",
      "Eval workspace changed while standard answers were being collected",
    );
  }

  const evalRunId = crypto.randomUUID();
  const createdAt = new Date();
  const caseResults = [];
  for (const item of suite.cases) {
    const beforeCase = await cleanWorkspaceSnapshot(cwd);
    if (!sameWorkspaceSnapshot(subject, beforeCase)) {
      caseResults.push(invalidWorkspaceCase(item, expected.get(item.id)));
      break;
    }
    try {
      caseResults.push(await runCase({
        item,
        expected: expected.get(item.id),
        cwd,
        agent,
        timeoutMs: input.timeout_ms ?? DEFAULT_CASE_TIMEOUT_MS,
      }));
    } catch (error) {
      caseResults.push(baseCaseResult(item, expected.get(item.id), null, {
        status: "error",
        reason: error?.code ?? "eval_case_error",
        metrics: { telemetry_status: "not-run" },
      }));
    }
    const afterCase = await cleanWorkspaceSnapshot(cwd);
    if (!sameWorkspaceSnapshot(subject, afterCase)) {
      caseResults[caseResults.length - 1] = {
        ...caseResults.at(-1),
        status: "invalid",
        reason: "workspace_changed",
      };
      break;
    }
  }

  const completedAt = new Date();
  const summary = summarizeCases(caseResults, suite.cases.length);
  const result = {
    schema_version: 1,
    kind: "agent-eval-run",
    eval_run_id: evalRunId,
    status: "completed",
    suite: {
      suite_id: suite.suite_id,
      suite_digest: suite.digest,
      relative_path: suite.relative_path,
      case_count: suite.cases.length,
    },
    subject: {
      cwd: subject.root,
      commit: subject.commit,
      workspace_digest: subject.workspace_digest,
    },
    agent: {
      agent_id: agent.agent_id,
      version: agent.version,
      model: agent.model,
      effort: agent.effort,
    },
    isolation: {
      policy: EVAL_EXECUTION_PROFILE,
      enforcement: "codex-permission-profile",
      data_read: ["workspace", "minimal-runtime", "private-per-case-scratch"],
      data_write: ["private-per-case-scratch"],
      git_history: false,
      tool_network: false,
      memory: "off",
      session_persistence: false,
      subagents: false,
    },
    grader_version: SOURCE_LOCATION_GRADER_VERSION,
    cases: caseResults,
    summary,
    created_at: createdAt.toISOString(),
    completed_at: completedAt.toISOString(),
    expires_at: evalExpiresAt(completedAt, internal.env ?? process.env),
  };
  const resultPath = await writeEvalResult(result, internal.env ?? process.env);
  return {
    ...result,
    artifact: { type: "eval-result", path: resultPath },
  };
}

async function resolveEvalAgent(input, cwd, env) {
  if (input.agent_id !== CODEX_AGENT_ID) {
    throw evalError(
      "unsupported_isolation",
      `Eval ${EVAL_EXECUTION_PROFILE} currently supports only ${CODEX_AGENT_ID}`,
    );
  }
  const adapter = getAdapter(input.agent_id);
  const availability = await adapter.getAvailability();
  if (!availability.available) {
    throw evalError(
      "agent_unavailable",
      `${adapter.displayName} CLI is not available: ${availability.reason}`,
    );
  }
  if (!supportsCodexEvalVersion(availability.version)) {
    throw evalError(
      "unsupported_isolation",
      `Codex Eval requires codex-cli ${CODEX_EVAL_MIN_VERSION.join(".")} or newer`,
    );
  }
  const described = await adapter.listAgent({ cwd, env });
  if (described.model_discovery?.status !== "available" || described.models.length === 0) {
    throw evalError(
      "eval_model_unavailable",
      `Codex model discovery is unavailable: ${described.model_discovery?.reason ?? "empty catalog"}`,
    );
  }
  const model = input.model
    ? described.models.find((item) => item.id === input.model)
    : described.models.find((item) => item.recommended) ?? described.models[0];
  if (!model) {
    throw evalError("eval_model_unavailable", `Codex model is not available: ${input.model}`);
  }
  const effort = input.effort ?? model.default_effort ?? null;
  if (
    effort &&
    Array.isArray(model.supported_efforts) &&
    model.supported_efforts.length > 0 &&
    !model.supported_efforts.includes(effort)
  ) {
    throw evalError(
      "invalid_eval_effort",
      `Effort ${effort} is not supported by model ${model.id}`,
    );
  }
  return {
    agent_id: input.agent_id,
    version: availability.version,
    model: model.id,
    effort,
  };
}

async function collectAnswers(suite, cwd, io) {
  if (typeof io?.readLine !== "function") {
    throw evalError("interactive_eval_required", "Eval run requires an interactive terminal");
  }
  const answers = new Map();
  for (const [index, item] of suite.cases.entries()) {
    io.stderr(`\n[${index + 1}/${suite.cases.length}] ${item.id}\n${item.prompt}\n\n`);
    while (true) {
      const raw = {
        path: await io.readLine("standard path: "),
        symbol: await io.readLine("standard symbol: "),
        definition_line: Number(await io.readLine("standard definition line: ")),
      };
      try {
        answers.set(item.id, await normalizeExpectedSourceLocation(raw, cwd));
        break;
      } catch (error) {
        if (error?.code !== "invalid_eval_answer") throw error;
        io.stderr(`Invalid standard answer: ${error.message}\nPlease enter this case again.\n`);
      }
    }
  }
  io.stderr("\nStandard answers accepted; starting isolated evaluation.\n");
  return answers;
}

async function runCase({ item, expected, cwd, agent, timeoutMs }) {
  const scratchPath = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-eval-case-"));
  await fsp.chmod(scratchPath, 0o700).catch(() => undefined);
  const schemaPath = path.join(scratchPath, "source-location.schema.json");
  await fsp.writeFile(schemaPath, `${JSON.stringify(SOURCE_LOCATION_OUTPUT_SCHEMA)}\n`, {
    mode: 0o600,
  });
  let accepted;
  let snapshot;
  try {
    accepted = await dispatchToAgent(
      {
        agent_id: agent.agent_id,
        cwd,
        prompt: buildEvalPrompt(item),
        metadata: {
          model: agent.model,
          codex: agent.effort ? { effort: agent.effort } : {},
        },
      },
      {
        execution_profile: {
          kind: EVAL_EXECUTION_PROFILE,
          scratch_path: scratchPath,
          output_schema_path: schemaPath,
        },
      },
    );
    snapshot = await waitAgentRun({
      run_ref: accepted.run_ref,
      timeout_ms: timeoutMs,
      poll_interval_ms: 250,
    });
    if (snapshot.timed_out) {
      const cancelled = await cancelAgentRun({
        run_ref: accepted.run_ref,
        reason: "eval case timed out",
        actor: "agenthub-eval",
      });
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "error",
        reason: "timeout",
        metrics: await evalMetrics(accepted.run_ref, cancelled),
      });
    }
    if (snapshot.status !== "completed") {
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "error",
        reason: snapshot.error?.code ?? snapshot.status,
        metrics: await evalMetrics(accepted.run_ref, snapshot),
      });
    }
    let actual;
    try {
      actual = parseSourceLocationOutput(snapshot.content?.[0]?.text ?? "");
    } catch (error) {
      return baseCaseResult(item, expected, accepted.run_ref, {
        status: "fail",
        reason: error.code ?? "invalid_agent_output",
        metrics: await evalMetrics(accepted.run_ref, snapshot),
      });
    }
    return baseCaseResult(item, expected, accepted.run_ref, {
      status: gradeSourceLocation(expected, actual) ? "pass" : "fail",
      reason: gradeSourceLocation(expected, actual) ? "exact_match" : "incorrect",
      metrics: await evalMetrics(accepted.run_ref, snapshot),
    });
  } finally {
    await fsp.rm(scratchPath, { recursive: true, force: true });
  }
}

function baseCaseResult(item, expected, runRef, fields) {
  return {
    case_id: item.id,
    question_digest: item.question_digest,
    answer_digest: answerDigest(expected),
    agent_run_ref: runRef,
    ...fields,
  };
}

function invalidWorkspaceCase(item, expected) {
  return baseCaseResult(item, expected, null, {
    status: "invalid",
    reason: "workspace_changed",
    metrics: { telemetry_status: "not-run" },
  });
}

async function evalMetrics(runRef, snapshot) {
  const started = Date.parse(snapshot.started_at ?? "");
  const completed = Date.parse(snapshot.completed_at ?? "");
  const metrics = {
    telemetry_status: "available",
    turns: undefined,
    tool_calls: undefined,
    observed_file_reads: undefined,
    observed_unique_files: undefined,
    elapsed_ms:
      Number.isFinite(started) && Number.isFinite(completed) && completed >= started
        ? completed - started
        : undefined,
    usage: snapshot.usage,
  };
  try {
    const eventsText = await readTextIfExists(path.join(runDirFor(runRef), "events.jsonl"));
    if (eventsText === null) {
      return compact({ ...metrics, telemetry_status: "missing-events" });
    }
    const events = projectLiveStream("codex", eventsText, { profile: "inspect" });
    const toolCalls = events.filter((event) => event.kind === "tool-call");
    const turnEnd = events.findLast?.((event) => event.kind === "turn-end") ??
      [...events].reverse().find((event) => event.kind === "turn-end");
    const fileReads = toolCalls.flatMap((event) =>
      Array.isArray(event.data?.resource_accesses)
        ? event.data.resource_accesses.filter(
            (access) => access?.operation === "read" && access?.resource_kind === "file",
          )
        : [],
    );
    return compact({
      ...metrics,
      turns: events.filter((event) => event.kind === "turn-start").length,
      tool_calls: toolCalls.length,
      observed_file_reads: fileReads.length,
      observed_unique_files: new Set(fileReads.map((access) => access.path)).size,
      usage: snapshot.usage ?? turnEnd?.data?.usage,
      canonical_usage: turnEnd?.data?.canonical_usage,
    });
  } catch {
    return compact({ ...metrics, telemetry_status: "projection-error" });
  }
}

function summarizeCases(cases, planned) {
  const counts = { pass: 0, fail: 0, invalid: 0, error: 0, not_run: planned - cases.length };
  for (const item of cases) {
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
  }
  return { total: planned, ...counts };
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

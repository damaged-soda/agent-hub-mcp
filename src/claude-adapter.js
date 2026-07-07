import crypto from "node:crypto";
import path from "node:path";
import {
  assertMetadataString,
  defaultModelFromEnv,
  resolveUnifiedPermission,
  runVersionCommand,
} from "./adapter-utils.js";

export const CLAUDE_AGENT_ID = "claude-code";
const AVAILABILITY_CACHE_MS = 30000;
const PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);
const UNIFIED_PERMISSION_TO_MODE = {
  "read-only": "plan",
  auto: "auto",
  full: "bypassPermissions",
};
const OUTPUT_FORMATS = new Set(["json", "stream-json"]);
const DEFAULT_OUTPUT_FORMAT = "stream-json";
const DEFAULT_MODEL_ENV_KEY = "AGENT_HUB_CLAUDE_MODEL";

let availabilityCache = null;

export function createClaudeSessionRef(cliSessionRef) {
  if (cliSessionRef?.native_session_id) {
    return {
      agent_id: CLAUDE_AGENT_ID,
      native_session_id: String(cliSessionRef.native_session_id),
      resumed: true,
    };
  }
  return {
    agent_id: CLAUDE_AGENT_ID,
    native_session_id: crypto.randomUUID(),
    resumed: false,
  };
}

export async function getClaudeAvailability() {
  if (
    availabilityCache &&
    Date.now() - availabilityCache.checkedAtMs < AVAILABILITY_CACHE_MS
  ) {
    return availabilityCache.value;
  }
  const result = await runVersionCommand("claude", ["--version"], 5000);
  const value =
    result.error || result.code !== 0 || !isClaudeVersionOutput(result.stdout, result.stderr)
      ? {
          available: false,
          reason:
            result.error?.message ||
            result.stderr.trim() ||
            result.stdout.trim() ||
            `exit ${result.code}`,
        }
      : {
          available: true,
          version: (result.stdout || result.stderr).trim(),
        };
  availabilityCache = {
    checkedAtMs: Date.now(),
    value,
  };
  return value;
}

function isClaudeVersionOutput(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.trim();
  return text.includes("Claude Code");
}

export function buildClaudeCommand({ request, effectiveCliSessionRef, env = process.env }) {
  if (
    !effectiveCliSessionRef ||
    typeof effectiveCliSessionRef.native_session_id !== "string" ||
    effectiveCliSessionRef.native_session_id.trim() === ""
  ) {
    throw new Error("effective_cli_session_ref.native_session_id must be a non-empty string");
  }
  const usingResolvedMetadata = Boolean(request.resolved_metadata);
  const meta = request.resolved_metadata ?? request.metadata ?? {};
  const claude = meta.claude ?? {};
  const outputFormat =
    assertMetadataString(claude.output_format, "metadata.claude.output_format") ??
    DEFAULT_OUTPUT_FORMAT;
  if (!OUTPUT_FORMATS.has(outputFormat)) {
    throw new Error(
      `metadata.claude.output_format must be one of: ${Array.from(OUTPUT_FORMATS).join(
        ", ",
      )}`,
    );
  }

  const argv = ["claude", "-p", "--input-format", "text", "--output-format", outputFormat];
  if (outputFormat === "stream-json") {
    argv.push("--verbose");
  }

  if (effectiveCliSessionRef?.resumed) {
    argv.push("--resume", effectiveCliSessionRef.native_session_id);
  } else {
    argv.push("--session-id", effectiveCliSessionRef.native_session_id);
  }

  const model =
    assertMetadataString(claude.model, "metadata.claude.model") ??
    assertMetadataString(meta.model, "metadata.model") ??
    defaultModelFromEnv(env, DEFAULT_MODEL_ENV_KEY);
  if (model) {
    argv.push("--model", model);
  }

  const effort =
    assertMetadataString(claude.effort, "metadata.claude.effort") ??
    assertMetadataString(meta.effort, "metadata.effort");
  if (effort) {
    argv.push("--effort", effort);
  }

  const agent = assertMetadataString(claude.agent, "metadata.claude.agent");
  if (agent) {
    argv.push("--agent", agent);
  }

  const permissionMode =
    assertMetadataString(claude.permission_mode, "metadata.claude.permission_mode") ??
    UNIFIED_PERMISSION_TO_MODE[resolveUnifiedPermission(meta)];
  if (!PERMISSION_MODES.has(permissionMode)) {
    throw new Error(
      `metadata.claude.permission_mode must be one of: ${Array.from(PERMISSION_MODES).join(
        ", ",
      )}`,
    );
  }
  argv.push("--permission-mode", permissionMode);

  const addDirs = claude.add_dirs ?? [];
  if (!Array.isArray(addDirs)) {
    throw new Error("metadata.claude.add_dirs must be an array");
  }
  if (!usingResolvedMetadata && addDirs.length > 0) {
    throw new Error("request.resolved_metadata is required when add_dirs are provided");
  }
  for (const addDir of addDirs) {
    if (typeof addDir !== "string" || addDir.trim() === "") {
      throw new Error("metadata.claude.add_dirs entries must be non-empty strings");
    }
    argv.push("--add-dir", usingResolvedMetadata ? addDir : path.resolve(addDir));
  }

  return {
    adapter_id: CLAUDE_AGENT_ID,
    command: argv[0],
    args: argv.slice(1),
    argv,
    output_format: outputFormat,
  };
}

export function parseClaudeJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude stdout was not valid JSON: ${message}`);
  }
}

export function parseClaudeStdout(stdout) {
  const parsed = typeof stdout === "string" ? parseClaudeJson(stdout) : stdout;
  if (typeof parsed?.result !== "string") {
    throw new Error("Claude JSON result field must be a string");
  }
  if (typeof parsed?.session_id !== "string" || parsed.session_id.trim() === "") {
    throw new Error("Claude JSON session_id field must be a non-empty string");
  }
  return {
    raw: parsed,
    resultText: parsed.result.trimEnd(),
    cliSessionRef: {
      agent_id: CLAUDE_AGENT_ID,
      native_session_id: parsed.session_id,
    },
  };
}

export function parseClaudeOutput(stdout, outputFormat = DEFAULT_OUTPUT_FORMAT) {
  if (outputFormat === "stream-json") {
    return parseClaudeStreamJson(stdout);
  }
  const raw = parseClaudeJson(stdout);
  const parsed = parseClaudeStdout(raw);
  return {
    outputFormat: "json",
    raw,
    resultJson: raw,
    resultText: parsed.resultText,
    cliSessionRef: parsed.cliSessionRef,
    isError: raw?.is_error === true,
  };
}

export function parseClaudeStreamJson(stdout) {
  const events = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseClaudeJsonLine(line))
    .filter(Boolean);
  const resultEvent =
    events.findLast?.((event) => event?.type === "result") ?? findLastResult(events);
  if (!resultEvent) {
    throw new Error("Claude stream-json stdout did not include a result event");
  }
  const sessionId = findSessionId(resultEvent, events);
  if (!sessionId) {
    throw new Error("Claude stream-json result did not include a session_id");
  }
  if (typeof resultEvent.result !== "string") {
    throw new Error("Claude stream-json result field must be a string");
  }
  const resultText = resultEvent.result.trimEnd();
  return {
    outputFormat: "stream-json",
    raw: events,
    resultJson: resultEvent,
    resultText,
    cliSessionRef: {
      agent_id: CLAUDE_AGENT_ID,
      native_session_id: sessionId,
    },
    isError: resultEvent.is_error === true,
  };
}

function parseClaudeJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function findLastResult(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "result") {
      return events[index];
    }
  }
  return null;
}

function findSessionId(resultEvent, events) {
  if (typeof resultEvent?.session_id === "string" && resultEvent.session_id.trim() !== "") {
    return resultEvent.session_id;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const sessionId = events[index]?.session_id;
    if (typeof sessionId === "string" && sessionId.trim() !== "") {
      return sessionId;
    }
  }
  return null;
}

export function interpretClaudeExit({ code, signal, stdout, stderr, outputFormat }) {
  if (code !== 0) {
    return {
      status: "failed",
      error: {
        code: "cli_exit_nonzero",
        message: `Claude exited with code ${code}${signal ? ` and signal ${signal}` : ""}`,
        exit_code: code,
        signal,
        stderr_tail: String(stderr ?? "").trimEnd().slice(-4000),
      },
    };
  }
  let parsed;
  try {
    parsed = parseClaudeOutput(stdout, outputFormat);
  } catch (error) {
    return {
      status: "failed",
      error: {
        code: "stdout_parse_failed",
        message: error instanceof Error ? error.message : String(error),
        exit_code: code,
        stdout_tail: String(stdout ?? "").trimEnd().slice(-4000),
      },
    };
  }
  if (parsed.isError) {
    return {
      status: "failed",
      error: {
        code: "agent_error",
        message: "Claude returned is_error=true",
        result_text: parsed.resultText || "Claude returned is_error=true",
        result_json: parsed.resultJson,
        exit_code: code,
        cli_session_ref: parsed.cliSessionRef,
      },
    };
  }
  return {
    status: "completed",
    resultText: parsed.resultText,
    resultJson: parsed.resultJson,
    cliSessionRef: parsed.cliSessionRef,
  };
}

export async function listClaudeAgent() {
  const availability = await getClaudeAvailability();
  return {
    agent_id: CLAUDE_AGENT_ID,
    title: "Claude Code",
    available: availability.available,
    version: availability.version,
    unavailable_reason: availability.available ? undefined : availability.reason,
    capabilities: {
      non_interactive: true,
      session_resume: true,
      command: "claude -p --input-format text --output-format stream-json --verbose",
    },
  };
}

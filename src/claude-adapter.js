import crypto from "node:crypto";
import path from "node:path";
import {
  assertMetadataString,
  defaultFromEnv,
  resolveUnifiedPermission,
  runCommand,
  runVersionCommand,
} from "./adapter-utils.js";

export const CLAUDE_AGENT_ID = "claude-code";
export const CLAUDE_DISCUSSION_CAPABILITIES = Object.freeze({
  supported_permissions: ["read-only", "auto"],
  preferred_discussion_permission: "read-only",
  network_access: { "read-only": "unknown", auto: true },
  max_prompt_bytes: 512 * 1024,
  session_resume: true,
});
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
const DEFAULT_EFFORT_ENV_KEY = "AGENT_HUB_CLAUDE_EFFORT";
const MODEL_DISCOVERY_SOURCE = "claude-code-control";
const MODEL_DISCOVERY_TIMEOUT_MS = 5000;
const MODEL_CATALOG_CACHE_MS = 30000;

let availabilityCache = null;
const modelCatalogCache = new Map();

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
    defaultFromEnv(env, DEFAULT_MODEL_ENV_KEY);
  if (model) {
    argv.push("--model", model);
  }

  // Effort vocabularies are CLI-specific, so the value stays in the adapter
  // namespace and falls back to an environment default instead of a unified field.
  const effort =
    assertMetadataString(claude.effort, "metadata.claude.effort") ??
    defaultFromEnv(env, DEFAULT_EFFORT_ENV_KEY);
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
  let parsed;
  let parseError;
  try {
    parsed = parseClaudeOutput(stdout, outputFormat);
  } catch (error) {
    parseError = error;
  }
  if (parsed?.isError) {
    const agentErrorCode = findClaudeAgentErrorCode(parsed);
    const authenticationFailed =
      agentErrorCode === "authentication_failed" ||
      /failed to authenticate|oauth session expired/i.test(parsed.resultText);
    return {
      status: "failed",
      error: {
        code: "agent_error",
        message: parsed.resultText || "Claude returned is_error=true",
        agent_error_code: agentErrorCode,
        result_text: parsed.resultText || "Claude returned is_error=true",
        result_json: parsed.resultJson,
        exit_code: code,
        signal,
        cli_session_ref: parsed.cliSessionRef,
        retryable: authenticationFailed ? false : undefined,
      },
    };
  }
  if (code !== 0) {
    return {
      status: "failed",
      error: {
        code: "cli_exit_nonzero",
        message: `Claude exited with code ${code}${signal ? ` and signal ${signal}` : ""}`,
        exit_code: code,
        signal,
        stderr_tail: String(stderr ?? "").trimEnd().slice(-4000),
        stdout_tail: String(stdout ?? "").trimEnd().slice(-4000),
      },
    };
  }
  if (parseError) {
    return {
      status: "failed",
      error: {
        code: "stdout_parse_failed",
        message: parseError instanceof Error ? parseError.message : String(parseError),
        exit_code: code,
        stdout_tail: String(stdout ?? "").trimEnd().slice(-4000),
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

function findClaudeAgentErrorCode(parsed) {
  if (Array.isArray(parsed?.raw)) {
    for (let index = parsed.raw.length - 1; index >= 0; index -= 1) {
      const code = parsed.raw[index]?.error;
      if (typeof code === "string" && code.trim() !== "") {
        return code;
      }
    }
  }
  const code = parsed?.raw?.error;
  return typeof code === "string" && code.trim() !== "" ? code : undefined;
}

export async function listClaudeAgent(options = {}) {
  const availability = await getClaudeAvailability();
  const catalog = availability.available
    ? await getClaudeModelCatalog(options)
    : unavailableModelCatalog("agent CLI is unavailable");
  return {
    agent_id: CLAUDE_AGENT_ID,
    title: "Claude Code",
    available: availability.available,
    version: availability.version,
    unavailable_reason: availability.available ? undefined : availability.reason,
    models: catalog.models,
    model_discovery: catalog.model_discovery,
    capabilities: {
      non_interactive: true,
      session_resume: true,
      command: "claude -p --input-format text --output-format stream-json --verbose",
      discussion: CLAUDE_DISCUSSION_CAPABILITIES,
    },
  };
}

export async function getClaudeModelCatalog({ cwd = process.cwd(), env = process.env } = {}) {
  const cacheKey = [
    cwd,
    env.CLAUDE_CONFIG_DIR ?? "",
    env.ANTHROPIC_BASE_URL ?? "",
    env.CLAUDE_CODE_USE_BEDROCK ?? "",
    env.CLAUDE_CODE_USE_VERTEX ?? "",
  ].join("\0");
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAtMs < MODEL_CATALOG_CACHE_MS) {
    return cached.value;
  }

  const requestId = `agent-hub-list-models-${crypto.randomUUID()}`;
  const request = `${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "list_models" },
  })}\n`;
  const result = await runCommand(
    "claude",
    [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--no-session-persistence",
    ],
    { cwd, env, input: request, timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS },
  );

  let value;
  if (result.error || result.code !== 0) {
    value = unavailableModelCatalog(commandFailureReason(result));
  } else {
    try {
      value = availableModelCatalog(parseClaudeModelCatalog(result.stdout, requestId));
    } catch (error) {
      value = unavailableModelCatalog(error.message);
    }
  }
  modelCatalogCache.set(cacheKey, { checkedAtMs: Date.now(), value });
  return value;
}

export function parseClaudeModelCatalog(stdout, requestId) {
  const response = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find(
      (message) =>
        message?.type === "control_response" &&
        message?.response?.request_id === requestId,
    );
  if (!response) {
    throw new Error("Claude model discovery did not return a matching control response");
  }
  if (response.response?.subtype !== "success") {
    throw new Error("Claude model discovery control request failed");
  }
  const rawModels = response.response?.response?.models;
  if (!Array.isArray(rawModels)) {
    throw new Error("Claude model discovery response did not include a models array");
  }
  return rawModels.flatMap((model) => normalizeClaudeModel(model));
}

function normalizeClaudeModel(raw) {
  if (!raw || typeof raw.value !== "string" || raw.value.trim() === "") {
    return [];
  }
  const model = {
    id: raw.value,
    display_name:
      typeof raw.displayName === "string" && raw.displayName.trim()
        ? raw.displayName
        : raw.value,
  };
  copyNonEmptyString(raw, "resolvedModel", model, "resolved_id");
  copyNonEmptyString(raw, "description", model, "description");
  if (raw.value === "default") model.recommended = true;
  const efforts = stringArray(raw.supportedEffortLevels);
  if (efforts.length > 0) model.supported_efforts = efforts;
  const capabilities = [];
  if (raw.supportsEffort === true) capabilities.push("effort");
  if (raw.supportsAdaptiveThinking === true) capabilities.push("adaptive_thinking");
  if (raw.supportsFastMode === true) capabilities.push("fast_mode");
  if (raw.supportsAutoMode === true) capabilities.push("auto_mode");
  if (capabilities.length > 0) model.capabilities = capabilities;
  return [model];
}

function availableModelCatalog(models) {
  return {
    models,
    model_discovery: { status: "available", source: MODEL_DISCOVERY_SOURCE },
  };
}

function unavailableModelCatalog(reason) {
  return {
    models: [],
    model_discovery: {
      status: "unavailable",
      source: MODEL_DISCOVERY_SOURCE,
      reason,
    },
  };
}

function commandFailureReason(result) {
  if (result.error?.message) return result.error.message;
  return `Claude model discovery exited with code ${result.code}`;
}

function copyNonEmptyString(source, sourceKey, target, targetKey) {
  const value = source?.[sourceKey];
  if (typeof value === "string" && value.trim()) target[targetKey] = value;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim() !== "")
    : [];
}

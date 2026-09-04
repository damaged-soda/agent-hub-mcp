import {
  assertMetadataString,
  defaultFromEnv,
  resolveUnifiedPermission,
  runCommand,
  runVersionCommand,
} from "./adapter-utils.js";

export const OPENCODE_AGENT_ID = "opencode";
export const OPENCODE_DISCUSSION_CAPABILITIES = Object.freeze({
  supported_permissions: ["auto"],
  preferred_discussion_permission: "auto",
  network_access: { auto: true },
  max_prompt_bytes: 512 * 1024,
  session_resume: true,
});

const AVAILABILITY_CACHE_MS = 30000;
const AVAILABILITY_PROBE_TIMEOUT_MS = 15000;
const AVAILABILITY_RETRY_DELAY_MS = 100;
const DEFAULT_MODEL_ENV_KEY = "AGENT_HUB_OPENCODE_MODEL";
const DEFAULT_EFFORT_ENV_KEY = "AGENT_HUB_OPENCODE_EFFORT";
const MODEL_DISCOVERY_SOURCE = "opencode-models";
const MODEL_DISCOVERY_TIMEOUT_MS = 10000;
const MODEL_CATALOG_CACHE_MS = 30000;
const MODEL_DISCOVERY_RETRY_DELAYS_MS = Object.freeze([100, 250, 500]);
const SESSION_ID_PATTERN = /^ses_[0-9A-Za-z]{8,128}$/;
const MODEL_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:@+-]*(?:\/[0-9A-Za-z][0-9A-Za-z._:@+-]*)+$/;
const REQUIRED_RUN_FLAGS = ["--format", "--session", "--model", "--variant", "--auto"];
const TAIL_LIMIT = 4000;
const TRANSIENT_DATABASE_LOCK_PATTERN =
  /\b(?:database|table)\s+is\s+locked\b|\bSQLITE_BUSY(?:_TIMEOUT)?\b/i;

let availabilityCache = null;
const modelCatalogCache = new Map();

// OpenCode assigns the session id and reports it on every JSON event. New
// dispatches therefore start without a ref; the runner backfills it from the
// first event and can preserve it even when a later cancellation wins.
export function createOpenCodeSessionRef(cliSessionRef) {
  if (cliSessionRef?.native_session_id) {
    const nativeSessionId = String(cliSessionRef.native_session_id);
    assertOpenCodeSessionId(nativeSessionId);
    return {
      agent_id: OPENCODE_AGENT_ID,
      native_session_id: nativeSessionId,
      resumed: true,
    };
  }
  return {
    agent_id: OPENCODE_AGENT_ID,
    native_session_id: null,
    resumed: false,
  };
}

export async function getOpenCodeAvailability() {
  if (
    availabilityCache &&
    Date.now() - availabilityCache.checkedAtMs < AVAILABILITY_CACHE_MS
  ) {
    return availabilityCache.value;
  }
  const { result, help } = await runOpenCodeAvailabilityProbe();
  const version = parseOpenCodeVersion(result.stdout, result.stderr);
  const missingFlags = missingOpenCodeRunFlags(help.stdout, help.stderr);
  let value;
  if (result.error || result.code !== 0 || !version) {
    value = {
      available: false,
      reason:
        result.error?.message ||
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit ${result.code}`,
    };
  } else if (help.error || help.code !== 0 || missingFlags.length > 0) {
    value = {
      available: false,
      reason:
        help.error?.message ||
        (missingFlags.length > 0
          ? `opencode run is missing required flags: ${missingFlags.join(", ")}`
          : help.stderr.trim() || `opencode run --help exited with code ${help.code}`),
    };
  } else {
    value = {
      available: true,
      version: (result.stdout || result.stderr).trim(),
    };
  }
  availabilityCache = { checkedAtMs: Date.now(), value };
  return value;
}

export async function runOpenCodeAvailabilityProbe({
  runVersion = runVersionCommand,
  runHelp = runCommand,
  wait = sleep,
} = {}) {
  const probe = async () => {
    const [result, help] = await Promise.all([
      runVersion("opencode", ["--version"], AVAILABILITY_PROBE_TIMEOUT_MS),
      runHelp("opencode", ["run", "--help"], {
        timeoutMs: AVAILABILITY_PROBE_TIMEOUT_MS,
      }),
    ]);
    return { result, help };
  };

  const first = await probe();
  const retryVersion = isCommandTimeout(first.result);
  const retryHelp = isCommandTimeout(first.help);
  if (!retryVersion && !retryHelp) {
    return first;
  }
  await wait(AVAILABILITY_RETRY_DELAY_MS);
  const [result, help] = await Promise.all([
    retryVersion
      ? runVersion("opencode", ["--version"], AVAILABILITY_PROBE_TIMEOUT_MS)
      : first.result,
    retryHelp
      ? runHelp("opencode", ["run", "--help"], {
          timeoutMs: AVAILABILITY_PROBE_TIMEOUT_MS,
        })
      : first.help,
  ]);
  return { result, help };
}

function isCommandTimeout(result) {
  return result?.error?.message === `Timed out after ${AVAILABILITY_PROBE_TIMEOUT_MS}ms`;
}

export function parseOpenCodeVersion(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function missingOpenCodeRunFlags(stdout, stderr = "") {
  const text = `${stdout}\n${stderr}`;
  return REQUIRED_RUN_FLAGS.filter((flag) => !text.includes(flag));
}

export function buildOpenCodeCommand({ request, effectiveCliSessionRef, env = process.env }) {
  const resumed = effectiveCliSessionRef?.resumed === true;
  if (resumed) assertOpenCodeSessionId(effectiveCliSessionRef.native_session_id);
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw new Error("request.prompt must be a non-empty string");
  }

  const meta = request.resolved_metadata ?? request.metadata ?? {};
  const opencode = meta[OPENCODE_AGENT_ID] ?? {};
  const argv = ["opencode", "run", "--format", "json"];

  if (resumed) argv.push("--session", effectiveCliSessionRef.native_session_id);

  const model =
    assertMetadataString(opencode.model, "metadata.opencode.model") ??
    assertMetadataString(meta.model, "metadata.model") ??
    defaultFromEnv(env, DEFAULT_MODEL_ENV_KEY);
  if (model) argv.push("--model", model);

  // OpenCode calls reasoning effort a model variant. Keep the vocabulary in
  // the adapter namespace and let the provider reject unsupported values.
  const effort =
    assertMetadataString(opencode.effort, "metadata.opencode.effort") ??
    defaultFromEnv(env, DEFAULT_EFFORT_ENV_KEY);
  if (effort) argv.push("--variant", effort);

  const agent = assertMetadataString(opencode.agent, "metadata.opencode.agent");
  if (agent) argv.push("--agent", agent);

  // Non-interactive OpenCode needs --auto to resolve approval requests. The
  // CLI treats it like yolo for asked permissions and has no workspace
  // filesystem boundary; only explicit deny rules remain enforced.
  const permission = resolveUnifiedPermission(meta);
  if (permission !== "auto") {
    throw new Error(
      `metadata.permission "${permission}" is not supported by opencode run: only --auto has a stable non-interactive permission contract`,
    );
  }
  argv.push("--auto");

  const addDirs = opencode.add_dirs ?? [];
  if (!Array.isArray(addDirs)) {
    throw new Error("metadata.opencode.add_dirs must be an array");
  }
  if (addDirs.length > 0) {
    throw new Error("metadata.opencode.add_dirs is not supported: opencode run has no add-dir boundary");
  }

  // The shared runner already writes the exact prompt to stdin. OpenCode
  // merges positional input with piped stdin, so adding an argv copy would
  // duplicate and quote-mangle the model-visible prompt.
  return {
    adapter_id: OPENCODE_AGENT_ID,
    command: argv[0],
    args: argv.slice(1),
    argv,
    // The native flag is named `--format json`, but its output is JSONL.
    output_format: "jsonl",
  };
}

export function openCodeSessionRefFromEvent(event) {
  const sessionId = event?.sessionID;
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId)
    ? { agent_id: OPENCODE_AGENT_ID, native_session_id: sessionId }
    : null;
}

export function parseOpenCodeStdout(stdout) {
  const events = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonLine(line))
    .filter(Boolean);

  let sessionId = null;
  let conflictingSessionIds = false;
  let resultText = null;
  let resultEvent = null;
  let errorEvent = null;
  for (const event of events) {
    const eventSessionId = event?.sessionID;
    if (typeof eventSessionId === "string" && SESSION_ID_PATTERN.test(eventSessionId)) {
      if (sessionId && sessionId !== eventSessionId) conflictingSessionIds = true;
      sessionId ??= eventSessionId;
    }
    if (
      event?.type === "text" &&
      event.part?.type === "text" &&
      typeof event.part.text === "string" &&
      event.part.text.trim() !== ""
    ) {
      resultText = event.part.text.trimEnd();
      resultEvent = event;
    }
    if (event?.type === "error") errorEvent = event;
  }

  return {
    raw: events,
    sessionId,
    conflictingSessionIds,
    resultText,
    resultJson: resultEvent,
    errorEvent,
    cliSessionRef:
      sessionId && !conflictingSessionIds
        ? { agent_id: OPENCODE_AGENT_ID, native_session_id: sessionId }
        : null,
  };
}

export function interpretOpenCodeExit({ code, signal, stdout, stderr }) {
  const parsed = parseOpenCodeStdout(stdout);
  if (parsed.conflictingSessionIds) {
    return failedParse(code, stdout, "OpenCode stdout contained conflicting session IDs");
  }
  if (parsed.errorEvent) {
    const detail = openCodeErrorMessage(parsed.errorEvent);
    return {
      status: "failed",
      error: {
        code: "agent_error",
        message: detail.slice(0, TAIL_LIMIT),
        result_text: detail,
        exit_code: code,
        signal,
        cli_session_ref: parsed.cliSessionRef ?? undefined,
      },
    };
  }
  if (code !== 0) {
    return {
      status: "failed",
      error: {
        code: "cli_exit_nonzero",
        message: `OpenCode exited with code ${code}${signal ? ` and signal ${signal}` : ""}`,
        exit_code: code,
        signal,
        stderr_tail: String(stderr ?? "").trimEnd().slice(-TAIL_LIMIT),
        cli_session_ref: parsed.cliSessionRef ?? undefined,
      },
    };
  }
  if (typeof parsed.resultText !== "string") {
    return failedParse(code, stdout, "OpenCode stdout did not include a text event");
  }
  if (!parsed.cliSessionRef) {
    return failedParse(code, stdout, "OpenCode stdout did not include a valid sessionID");
  }
  return {
    status: "completed",
    resultText: parsed.resultText,
    resultJson: parsed.resultJson,
    cliSessionRef: parsed.cliSessionRef,
  };
}

export async function listOpenCodeAgent(options = {}) {
  const availability = await getOpenCodeAvailability();
  const catalog = availability.available
    ? await getOpenCodeModelCatalog(options)
    : unavailableModelCatalog("agent CLI is unavailable");
  return {
    agent_id: OPENCODE_AGENT_ID,
    title: "OpenCode",
    available: availability.available,
    version: availability.version,
    unavailable_reason: availability.available ? undefined : availability.reason,
    models: catalog.models,
    model_discovery: catalog.model_discovery,
    capabilities: {
      non_interactive: true,
      session_resume: true,
      command: "opencode run --format json --auto",
      discussion: OPENCODE_DISCUSSION_CAPABILITIES,
    },
  };
}

export async function getOpenCodeModelCatalog({ cwd = process.cwd(), env = process.env } = {}) {
  const cacheKey = [
    cwd,
    env.OPENCODE_CONFIG ?? "",
    env.OPENCODE_CONFIG_DIR ?? "",
    env.XDG_DATA_HOME ?? "",
  ].join("\0");
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAtMs < MODEL_CATALOG_CACHE_MS) {
    return cached.value;
  }
  const result = await runOpenCodeModelsWithRetry({ cwd, env });
  let value;
  if (result.error || result.code !== 0) {
    value = unavailableModelCatalog(commandFailureReason(result));
  } else {
    try {
      value = availableModelCatalog(parseOpenCodeModelCatalog(result.stdout));
    } catch (error) {
      value = unavailableModelCatalog(error.message);
    }
  }
  modelCatalogCache.set(cacheKey, { checkedAtMs: Date.now(), value });
  return value;
}

async function runOpenCodeModelsWithRetry({ cwd, env }) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await runCommand("opencode", ["models"], {
      cwd,
      env,
      timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
    });
    const retryDelayMs = MODEL_DISCOVERY_RETRY_DELAYS_MS[attempt];
    if (!isTransientDatabaseLock(result) || retryDelayMs === undefined) {
      return result;
    }
    await sleep(retryDelayMs);
  }
}

function isTransientDatabaseLock(result) {
  if (!result || (!result.error && result.code === 0)) return false;
  return [result?.error?.message, result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string")
    .some((value) => TRANSIENT_DATABASE_LOCK_PATTERN.test(value));
}

export function parseOpenCodeModelCatalog(stdout) {
  const seen = new Set();
  const models = [];
  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const id = stripAnsi(rawLine).trim();
    if (!MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, display_name: id });
  }
  return models;
}

function openCodeErrorMessage(event) {
  const candidates = [event?.error?.data?.message, event?.error?.message, event?.error?.name];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim()
    ?? "OpenCode reported an agent error";
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
    model_discovery: { status: "unavailable", source: MODEL_DISCOVERY_SOURCE, reason },
  };
}

function commandFailureReason(result) {
  if (result.error?.message) return result.error.message;
  const stderr = compactDiagnostic(result.stderr);
  if (stderr) return stderr;
  return `OpenCode model discovery exited with code ${result.code}`;
}

function compactDiagnostic(value) {
  const normalized = stripAnsi(String(value ?? ""))
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > TAIL_LIMIT
    ? `${normalized.slice(0, TAIL_LIMIT - 1)}…`
    : normalized;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertOpenCodeSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new Error("cli_session_ref.native_session_id must be an OpenCode session id (ses_<id>)");
  }
}

function failedParse(code, stdout, message) {
  return {
    status: "failed",
    error: {
      code: "stdout_parse_failed",
      message,
      exit_code: code,
      stdout_tail: String(stdout ?? "").trimEnd().slice(-TAIL_LIMIT),
    },
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

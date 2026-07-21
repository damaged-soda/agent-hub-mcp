import path from "node:path";
import {
  assertMetadataString,
  defaultFromEnv,
  resolveUnifiedPermission,
  runCommand,
  runVersionCommand,
} from "./adapter-utils.js";

export const KIMI_AGENT_ID = "kimi-code";
export const KIMI_DISCUSSION_CAPABILITIES = Object.freeze({
  supported_permissions: ["auto"],
  preferred_discussion_permission: "auto",
  network_access: { auto: true },
  max_prompt_bytes: 512 * 1024,
  session_resume: true,
});
const AVAILABILITY_CACHE_MS = 30000;
const DEFAULT_MODEL_ENV_KEY = "AGENT_HUB_KIMI_MODEL";
const DEFAULT_EFFORT_ENV_KEY = "AGENT_HUB_KIMI_EFFORT";
const CHILD_EFFORT_ENV_KEY = "KIMI_MODEL_THINKING_EFFORT";
const MODEL_DISCOVERY_SOURCE = "kimi-provider-list";
const MODEL_DISCOVERY_TIMEOUT_MS = 5000;
const MODEL_CATALOG_CACHE_MS = 30000;
// Kimi session ids look like session_<uuid>; the official migrator from the
// legacy kimi-cli registers migrated sessions as ses_<uuid>. The resume id is
// an argv value, so anything else (for example "--help") would be parsed as a
// kimi option.
const SESSION_ID_PATTERN =
  /^(?:session|ses)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The structured session.resume_hint stream event (the session-id backfill
// contract) was introduced in Kimi Code 0.2.0 — per cross-review finding;
// not verified against an upstream changelog.
const MIN_KIMI_VERSION = [0, 2, 0];
const TAIL_LIMIT = 4000;

let availabilityCache = null;
const modelCatalogCache = new Map();

// Kimi assigns the session id itself and reports it in the final
// session.resume_hint meta event, so a new session starts with
// native_session_id: null until the run completes and the runner backfills it.
export function createKimiSessionRef(cliSessionRef) {
  if (cliSessionRef?.native_session_id) {
    const nativeSessionId = String(cliSessionRef.native_session_id);
    assertKimiSessionId(nativeSessionId);
    return {
      agent_id: KIMI_AGENT_ID,
      native_session_id: nativeSessionId,
      resumed: true,
    };
  }
  return {
    agent_id: KIMI_AGENT_ID,
    native_session_id: null,
    resumed: false,
  };
}

export async function getKimiAvailability() {
  if (
    availabilityCache &&
    Date.now() - availabilityCache.checkedAtMs < AVAILABILITY_CACHE_MS
  ) {
    return availabilityCache.value;
  }
  const result = await runVersionCommand("kimi", ["--version"], 5000);
  const version = parseKimiVersion(result.stdout, result.stderr);
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
  } else if (!isSupportedKimiVersion(version)) {
    value = {
      available: false,
      reason: `kimi ${version.join(".")} is below the minimum supported version ${MIN_KIMI_VERSION.join(
        ".",
      )} (session.resume_hint stream event required)`,
    };
  } else {
    value = {
      available: true,
      version: (result.stdout || result.stderr).trim(),
    };
  }
  availabilityCache = {
    checkedAtMs: Date.now(),
    value,
  };
  return value;
}

// `kimi --version` prints a bare semver (e.g. "0.26.0"). The legacy kimi-cli
// prints "kimi, version 1.49.0"; its session/JSONL contract is incompatible,
// so only an exact bare-semver line counts.
export function parseKimiVersion(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedKimiVersion(version) {
  for (let index = 0; index < MIN_KIMI_VERSION.length; index += 1) {
    if (version[index] !== MIN_KIMI_VERSION[index]) {
      return version[index] > MIN_KIMI_VERSION[index];
    }
  }
  return true;
}

export function buildKimiCommand({ request, effectiveCliSessionRef, env = process.env }) {
  const resumed = effectiveCliSessionRef?.resumed === true;
  if (resumed) {
    assertKimiSessionId(effectiveCliSessionRef.native_session_id);
  }
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw new Error("request.prompt must be a non-empty string");
  }
  const usingResolvedMetadata = Boolean(request.resolved_metadata);
  const meta = request.resolved_metadata ?? request.metadata ?? {};
  const kimi = meta[KIMI_AGENT_ID] ?? {};

  const argv = ["kimi"];
  if (resumed) {
    argv.push("--session", effectiveCliSessionRef.native_session_id);
  }
  // kimi -p only takes the prompt as an argv value; it never reads stdin.
  argv.push("-p", request.prompt, "--output-format", "stream-json");

  const model =
    assertMetadataString(kimi.model, "metadata.kimi-code.model") ??
    assertMetadataString(meta.model, "metadata.model") ??
    defaultFromEnv(env, DEFAULT_MODEL_ENV_KEY);
  if (model) {
    argv.push("-m", model);
  }

  // Effort vocabularies are CLI-specific, so the value stays in the adapter
  // namespace and falls back to a server-side default instead of a unified field.
  // kimi has no effort flag; the child process reads KIMI_MODEL_THINKING_EFFORT.
  // The value is passed through unvalidated (env values carry no injection risk);
  // kimi rejects unknown values with a normal agent_error failure.
  const effort =
    assertMetadataString(kimi.effort, "metadata.kimi-code.effort") ??
    defaultFromEnv(env, DEFAULT_EFFORT_ENV_KEY);

  // kimi -p has no permission flags: --plan/--auto/--yolo all conflict with -p,
  // and prompt mode always applies its built-in auto approval. Only the unified
  // default ("auto") maps onto that; anything else would silently run with a
  // different access level than requested, so reject it instead.
  const permission = resolveUnifiedPermission(meta);
  if (permission !== "auto") {
    throw new Error(
      `metadata.permission "${permission}" is not supported by kimi -p: prompt mode always runs with auto approval`,
    );
  }

  const addDirs = kimi.add_dirs ?? [];
  if (!Array.isArray(addDirs)) {
    throw new Error("metadata.kimi-code.add_dirs must be an array");
  }
  if (!usingResolvedMetadata && addDirs.length > 0) {
    throw new Error("request.resolved_metadata is required when add_dirs are provided");
  }
  for (const addDir of addDirs) {
    if (typeof addDir !== "string" || addDir.trim() === "") {
      throw new Error("metadata.kimi-code.add_dirs entries must be non-empty strings");
    }
    argv.push("--add-dir", usingResolvedMetadata ? addDir : path.resolve(addDir));
  }

  return {
    adapter_id: KIMI_AGENT_ID,
    command: argv[0],
    args: argv.slice(1),
    argv,
    output_format: "stream-json",
    env: effort ? { [CHILD_EFFORT_ENV_KEY]: effort } : undefined,
  };
}

export function parseKimiStdout(stdout) {
  const events = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonLine(line))
    .filter(Boolean);

  let sessionId = null;
  let resultText = null;
  let resultEvent = null;
  for (const event of events) {
    // The session ref comes only from the terminal session.resume_hint meta
    // event, and only when the id has the expected shape — a stray session_id
    // field on any other event must not become a resumable ref.
    if (
      event?.role === "meta" &&
      event.type === "session.resume_hint" &&
      typeof event.session_id === "string" &&
      SESSION_ID_PATTERN.test(event.session_id)
    ) {
      sessionId = event.session_id;
    }
    if (
      event?.role === "assistant" &&
      typeof event.content === "string" &&
      event.content.trim() !== ""
    ) {
      resultText = event.content.trimEnd();
      resultEvent = event;
    }
  }

  return {
    raw: events,
    sessionId,
    resultText,
    resultJson: resultEvent,
    cliSessionRef: sessionId
      ? { agent_id: KIMI_AGENT_ID, native_session_id: sessionId }
      : null,
  };
}

export function interpretKimiExit({ code, signal, stdout, stderr }) {
  const parsed = parseKimiStdout(stdout);
  if (code !== 0) {
    // Model-side failures surface as `error: failed to run prompt: <detail>` on
    // stderr with no JSONL on stdout; treat them as agent_error, not CLI misuse.
    const promptFailure = /failed to run prompt:\s*(.+)/.exec(String(stderr ?? ""));
    if (promptFailure) {
      const detail = promptFailure[1].trim();
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
    return {
      status: "failed",
      error: {
        code: "cli_exit_nonzero",
        message: `Kimi exited with code ${code}${signal ? ` and signal ${signal}` : ""}`,
        exit_code: code,
        signal,
        stderr_tail: String(stderr ?? "").trimEnd().slice(-TAIL_LIMIT),
        cli_session_ref: parsed.cliSessionRef ?? undefined,
      },
    };
  }
  if (typeof parsed.resultText !== "string") {
    return failedParse(code, stdout, "Kimi stdout did not include an assistant message");
  }
  if (!parsed.cliSessionRef) {
    return failedParse(code, stdout, "Kimi stdout did not include a session.resume_hint session_id");
  }
  return {
    status: "completed",
    resultText: parsed.resultText,
    resultJson: parsed.resultJson,
    cliSessionRef: parsed.cliSessionRef,
  };
}

export async function listKimiAgent(options = {}) {
  const availability = await getKimiAvailability();
  const catalog = availability.available
    ? await getKimiModelCatalog(options)
    : unavailableModelCatalog("agent CLI is unavailable");
  return {
    agent_id: KIMI_AGENT_ID,
    title: "Kimi Code",
    available: availability.available,
    version: availability.version,
    unavailable_reason: availability.available ? undefined : availability.reason,
    models: catalog.models,
    model_discovery: catalog.model_discovery,
    capabilities: {
      non_interactive: true,
      session_resume: true,
      command: "kimi -p <prompt> --output-format stream-json",
      discussion: KIMI_DISCUSSION_CAPABILITIES,
    },
  };
}

export async function getKimiModelCatalog({ cwd = process.cwd(), env = process.env } = {}) {
  const cacheKey = [cwd, env.KIMI_CODE_HOME ?? ""].join("\0");
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAtMs < MODEL_CATALOG_CACHE_MS) {
    return cached.value;
  }
  const result = await runCommand("kimi", ["provider", "list", "--json"], {
    cwd,
    env,
    timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
  });
  let value;
  if (result.error || result.code !== 0) {
    value = unavailableModelCatalog(commandFailureReason(result));
  } else {
    try {
      value = availableModelCatalog(parseKimiModelCatalog(result.stdout));
    } catch (error) {
      value = unavailableModelCatalog(error.message);
    }
  }
  modelCatalogCache.set(cacheKey, { checkedAtMs: Date.now(), value });
  return value;
}

export function parseKimiModelCatalog(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? ""));
  } catch {
    throw new Error("Kimi model discovery returned invalid JSON");
  }
  if (!parsed?.models || typeof parsed.models !== "object" || Array.isArray(parsed.models)) {
    throw new Error("Kimi model discovery response did not include a models object");
  }
  return Object.entries(parsed.models).flatMap(([id, raw]) => normalizeKimiModel(id, raw));
}

function normalizeKimiModel(id, raw) {
  if (!id.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const model = {
    id,
    display_name:
      typeof raw.displayName === "string" && raw.displayName.trim()
        ? raw.displayName
        : id,
  };
  copyNonEmptyString(raw, "model", model, "resolved_id");
  copyNonEmptyString(raw, "defaultEffort", model, "default_effort");
  if (Number.isInteger(raw.maxContextSize) && raw.maxContextSize > 0) {
    model.context_window = raw.maxContextSize;
  }
  const efforts = stringArray(raw.supportEfforts);
  if (efforts.length > 0) model.supported_efforts = efforts;
  const capabilities = stringArray(raw.capabilities);
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
  return `Kimi model discovery exited with code ${result.code}`;
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

function assertKimiSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new Error(
      "cli_session_ref.native_session_id must be a Kimi session id (session_<uuid> or ses_<uuid>)",
    );
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

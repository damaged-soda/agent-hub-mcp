import path from "node:path";
import {
  assertMetadataString,
  defaultFromEnv,
  resolveUnifiedPermission,
  runCommand,
  runVersionCommand,
} from "./adapter-utils.js";
import { sessionRefFromLiveEvent } from "./agent-session-core.js";

export const CODEX_AGENT_ID = "codex";
export const CODEX_EVAL_MIN_VERSION = Object.freeze([0, 151, 0]);
export const CODEX_READONLY_EVAL_EXECUTION_PROFILE = "workspace-readonly/v1";
export const CODEX_PATCH_EVAL_EXECUTION_PROFILE = "workspace-write/v1";
export const CODEX_PATCH_EVAL_EXECUTION_PROFILE_V2 = "workspace-write/v2";
export const CODEX_EVAL_EXECUTION_PROFILE = CODEX_READONLY_EVAL_EXECUTION_PROFILE;
export const CODEX_EVAL_PERMISSION_PROFILE_NAME = "agenthub-eval";
const CODEX_EVAL_EXECUTION_PROFILES = new Set([
  CODEX_READONLY_EVAL_EXECUTION_PROFILE,
  CODEX_PATCH_EVAL_EXECUTION_PROFILE,
  CODEX_PATCH_EVAL_EXECUTION_PROFILE_V2,
]);
export const CODEX_DISCUSSION_CAPABILITIES = Object.freeze({
  supported_permissions: ["read-only", "auto"],
  preferred_discussion_permission: "read-only",
  network_access: { "read-only": false, auto: true },
  max_prompt_bytes: 512 * 1024,
  session_resume: true,
});
const AVAILABILITY_CACHE_MS = 30000;
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
// Unified permission "auto" matches Claude's auto mode: writable workspace plus
// network access. Setting metadata.codex.sandbox opts into codex-native
// semantics instead (workspace-write keeps codex's network-off default).
const UNIFIED_PERMISSION_TO_SANDBOX = {
  "read-only": "read-only",
  auto: "workspace-write",
  full: "danger-full-access",
};
const NETWORK_ACCESS_OVERRIDE = "sandbox_workspace_write.network_access=true";
const DEFAULT_MODEL_ENV_KEY = "AGENT_HUB_CODEX_MODEL";
const DEFAULT_EFFORT_ENV_KEY = "AGENT_HUB_CODEX_EFFORT";
const EFFORT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MODEL_DISCOVERY_SOURCE = "codex-debug-models";
const MODEL_DISCOVERY_TIMEOUT_MS = 5000;
const MODEL_CATALOG_CACHE_MS = 30000;
// Codex thread ids are UUIDs. The resume session id is a positional argv value,
// so anything else (for example "--last") would be parsed as a codex option and
// could resume an unrelated session.
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_LIMIT = 4000;

let availabilityCache = null;
const modelCatalogCache = new Map();

// Codex assigns the thread id itself and reports it in the first thread.started
// event, so a new session starts with native_session_id: null until the runner
// observes that event.
export function createCodexSessionRef(cliSessionRef) {
  if (cliSessionRef?.native_session_id) {
    const nativeSessionId = String(cliSessionRef.native_session_id);
    assertCodexSessionId(nativeSessionId);
    return {
      agent_id: CODEX_AGENT_ID,
      native_session_id: nativeSessionId,
      resumed: true,
    };
  }
  return {
    agent_id: CODEX_AGENT_ID,
    native_session_id: null,
    resumed: false,
  };
}

export async function getCodexAvailability() {
  if (
    availabilityCache &&
    Date.now() - availabilityCache.checkedAtMs < AVAILABILITY_CACHE_MS
  ) {
    return availabilityCache.value;
  }
  const result = await runVersionCommand("codex", ["--version"], 5000);
  const value =
    result.error || result.code !== 0 || !isCodexVersionOutput(result.stdout, result.stderr)
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

function isCodexVersionOutput(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.trim().toLowerCase();
  return text.includes("codex");
}

export function parseCodexVersion(value) {
  const match = /(?:^|\s)codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/i.exec(
    String(value ?? "").trim(),
  );
  return match ? match.slice(1).map(Number) : null;
}

export function supportsCodexEvalVersion(value) {
  const version = Array.isArray(value) ? value : parseCodexVersion(value);
  if (!version) return false;
  for (let index = 0; index < CODEX_EVAL_MIN_VERSION.length; index += 1) {
    if (version[index] > CODEX_EVAL_MIN_VERSION[index]) return true;
    if (version[index] < CODEX_EVAL_MIN_VERSION[index]) return false;
  }
  return true;
}

export function buildCodexCommand({ request, effectiveCliSessionRef, env = process.env }) {
  const resumed = effectiveCliSessionRef?.resumed === true;
  if (resumed) {
    assertCodexSessionId(effectiveCliSessionRef.native_session_id);
  }
  const usingResolvedMetadata = Boolean(request.resolved_metadata);
  const meta = request.resolved_metadata ?? request.metadata ?? {};
  const codex = meta.codex ?? {};
  const evalProfile = CODEX_EVAL_EXECUTION_PROFILES.has(request.execution_profile?.kind)
    ? request.execution_profile
    : null;
  if (request.execution_profile && !evalProfile) {
    throw new Error(`Unsupported Codex execution profile: ${request.execution_profile.kind}`);
  }
  if (evalProfile && resumed) {
    throw new Error("Eval execution profile cannot resume a Codex session");
  }
  const evalPathPrepend = evalProfile ? normalizedEvalPathPrepend(evalProfile.path_prepend) : null;
  const evalBirthPathPrepend = evalProfile?.kind === CODEX_PATCH_EVAL_EXECUTION_PROFILE_V2
    ? null
    : evalPathPrepend;
  const evalAgentExecutable = evalProfile
    ? normalizedEvalAgentExecutable(evalProfile.agent_executable)
    : null;
  const evalAgentInterpreter = evalProfile
    ? normalizedEvalAgentInterpreter(evalProfile.agent_interpreter)
    : null;

  const argv = [evalAgentExecutable ?? "codex", "exec"];
  if (resumed) {
    argv.push("resume", effectiveCliSessionRef.native_session_id);
  }
  argv.push("--json", "--skip-git-repo-check");

  const model =
    assertMetadataString(codex.model, "metadata.codex.model") ??
    assertMetadataString(meta.model, "metadata.model") ??
    defaultFromEnv(env, DEFAULT_MODEL_ENV_KEY);
  if (model) {
    argv.push("--model", model);
  }

  // Effort vocabularies are CLI-specific, so the value stays in the adapter
  // namespace and falls back to an environment default instead of a unified field.
  const effort =
    assertMetadataString(codex.effort, "metadata.codex.effort") ??
    defaultFromEnv(env, DEFAULT_EFFORT_ENV_KEY);
  if (effort) {
    if (!EFFORT_PATTERN.test(effort)) {
      throw new Error(
        "metadata.codex.effort must contain only letters, digits, hyphens, or underscores",
      );
    }
    argv.push("-c", `model_reasoning_effort="${effort}"`);
  }

  const addDirs = codex.add_dirs ?? [];
  if (!Array.isArray(addDirs)) {
    throw new Error("metadata.codex.add_dirs must be an array");
  }
  if (!usingResolvedMetadata && addDirs.length > 0) {
    throw new Error("request.resolved_metadata is required when add_dirs are provided");
  }
  const resolvedAddDirs = addDirs.map((addDir, index) => {
    if (typeof addDir !== "string" || addDir.trim() === "") {
      throw new Error(`metadata.codex.add_dirs[${index}] must be a non-empty string`);
    }
    return usingResolvedMetadata ? addDir : path.resolve(addDir);
  });

  if (evalProfile) {
    if (
      codex.sandbox !== undefined ||
      meta.permission !== undefined ||
      meta.add_dirs !== undefined ||
      resolvedAddDirs.length > 0
    ) {
      throw new Error("Eval execution profile owns sandbox, permission, and add_dirs settings");
    }
    appendEvalProfileArgs(argv, evalProfile);
  } else {
    const nativeSandbox = assertMetadataString(codex.sandbox, "metadata.codex.sandbox");
    let sandbox;
    let networkAccess = false;
    if (nativeSandbox) {
      if (!SANDBOX_MODES.has(nativeSandbox)) {
        throw new Error(
          `metadata.codex.sandbox must be one of: ${Array.from(SANDBOX_MODES).join(", ")}`,
        );
      }
      sandbox = nativeSandbox;
    } else {
      const permission = resolveUnifiedPermission(meta);
      sandbox = UNIFIED_PERMISSION_TO_SANDBOX[permission];
      networkAccess = permission === "auto";
    }

    // `codex exec resume` accepts a narrower flag set than `codex exec`; sandbox
    // and writable roots go through -c config overrides on continuations.
    if (resumed) {
      argv.push("-c", `sandbox_mode="${sandbox}"`);
      if (networkAccess) {
        argv.push("-c", NETWORK_ACCESS_OVERRIDE);
      }
      if (resolvedAddDirs.length > 0) {
        argv.push(
          "-c",
          `sandbox_workspace_write.writable_roots=${JSON.stringify(resolvedAddDirs)}`,
        );
      }
    } else {
      argv.push("--sandbox", sandbox);
      if (networkAccess) {
        argv.push("-c", NETWORK_ACCESS_OVERRIDE);
      }
      for (const addDir of resolvedAddDirs) {
        argv.push("--add-dir", addDir);
      }
    }
  }

  // Read the prompt from stdin.
  argv.push("-");

  return {
    adapter_id: CODEX_AGENT_ID,
    command: argv[0],
    args: argv.slice(1),
    argv,
    output_format: "jsonl",
    ...(evalAgentInterpreter ? { path_interpreter: evalAgentInterpreter } : {}),
    ...(evalBirthPathPrepend ? { path_prepend: evalBirthPathPrepend } : {}),
    ...(evalProfile
      ? {
          post_birth_env: {
            TMPDIR: path.resolve(evalProfile.scratch_path),
            TMP: path.resolve(evalProfile.scratch_path),
            TEMP: path.resolve(evalProfile.scratch_path),
          },
        }
      : {}),
    env: evalProfile
      ? {
          TMPDIR: path.resolve(evalProfile.scratch_path),
          TMP: path.resolve(evalProfile.scratch_path),
          TEMP: path.resolve(evalProfile.scratch_path),
        }
      : undefined,
  };
}

function appendEvalProfileArgs(argv, profile) {
  const scratchPath = absoluteProfilePath(profile.scratch_path, "execution_profile.scratch_path");
  const outputSchemaPath = absoluteProfilePath(
    profile.output_schema_path,
    "execution_profile.output_schema_path",
  );
  if (!isInside(outputSchemaPath, scratchPath)) {
    throw new Error("execution_profile.output_schema_path must be inside scratch_path");
  }
  argv.push(
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--disable",
    "memories",
    "--disable",
    "external_agent_memory_import",
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "--output-schema",
    outputSchemaPath,
    "-c",
    `default_permissions=${JSON.stringify(CODEX_EVAL_PERMISSION_PROFILE_NAME)}`,
    "-c",
    'approval_policy="never"',
    ...codexEvalPermissionArgs(profile),
  );
}

// Shared by normal Eval execution and its no-model `codex sandbox` preflight.
// The caller owns command-specific flags and selecting the named profile; this
// returns only the environment/permission config that must remain identical.
export function codexEvalPermissionArgs(profile) {
  if (!CODEX_EVAL_EXECUTION_PROFILES.has(profile?.kind)) {
    throw new Error(`Unsupported Codex execution profile: ${profile?.kind}`);
  }
  const scratchPath = absoluteProfilePath(profile.scratch_path, "execution_profile.scratch_path");
  if (!Array.isArray(profile.runtime_read_paths) || profile.runtime_read_paths.length === 0) {
    throw new Error("execution_profile.runtime_read_paths must be a non-empty array");
  }
  const runtimeRules = profile.runtime_read_paths.map((item, index) => {
    const runtimePath = absoluteProfilePath(
      item,
      `execution_profile.runtime_read_paths[${index}]`,
    );
    return `${JSON.stringify(runtimePath)} = "read"`;
  });
  const workspaceAccess = isCodexPatchEvalExecutionProfile(profile.kind)
    ? "write"
    : "read";
  const permissionProfile = [
    '{ description = "Agent Hub workspace-only evaluation"',
    'filesystem = { ":minimal" = "read"',
    `":workspace_roots" = { "." = "${workspaceAccess}", ".git" = "deny", ".git/**" = "deny" }`,
    ...runtimeRules,
    `${JSON.stringify(scratchPath)} = "write" }`,
    "network = { enabled = false } }",
  ].join(", ");
  const toolchainEnvironment = evalToolchainEnvironmentArgs(profile, scratchPath);
  return [
    "-c",
    'shell_environment_policy.inherit="core"',
    "-c",
    "allow_login_shell=false",
    ...toolchainEnvironment,
    "-c",
    `permissions.${CODEX_EVAL_PERMISSION_PROFILE_NAME}=${permissionProfile}`,
  ];
}

function isCodexPatchEvalExecutionProfile(kind) {
  return kind === CODEX_PATCH_EVAL_EXECUTION_PROFILE ||
    kind === CODEX_PATCH_EVAL_EXECUTION_PROFILE_V2;
}

function evalToolchainEnvironmentArgs(profile, scratchPath) {
  const { kind } = profile;
  if (!isCodexPatchEvalExecutionProfile(kind)) return [];
  if (kind === CODEX_PATCH_EVAL_EXECUTION_PROFILE) {
    return [
      ["PYTHONNOUSERSITE", "1"],
      ["PYTHONDONTWRITEBYTECODE", "1"],
      ["PYTHONPATH", ""],
      ["PYTHONHOME", ""],
      ["PYTHONPLATLIBDIR", ""],
      ["PYTHONEXECUTABLE", ""],
      ["__PYVENV_LAUNCHER__", ""],
    ].flatMap(([key, value]) => [
      "-c",
      `shell_environment_policy.set.${key}=${JSON.stringify(value)}`,
    ]);
  }
  const toolchainPath = normalizedEvalPathPrepend(profile.path_prepend);
  const taskHome = path.join(scratchPath, "task-home");
  const fixedValues = [
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_CONFIG_SYSTEM", "/dev/null"],
    ["HOME", taskHome],
    ["PATH", toolchainPath.join(path.delimiter)],
    ["PYTHONDONTWRITEBYTECODE", "1"],
    ["PYTHONNOUSERSITE", "1"],
    ["TEMP", scratchPath],
    ["TMP", scratchPath],
    ["TMPDIR", scratchPath],
    ["ZDOTDIR", taskHome],
  ];
  const args = fixedValues.flatMap(([key, value]) => [
    "-c",
    `shell_environment_policy.set.${key}=${JSON.stringify(value)}`,
  ]);
  const excludedVariables = [
    "BASH_ENV",
    "ENV",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_EXEC_PATH",
    "GIT_WORK_TREE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONEXECUTABLE",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONPLATLIBDIR",
    "ZDOTDIR",
    "__PYVENV_LAUNCHER__",
  ];
  args.push(
    "-c",
    `shell_environment_policy.exclude=${JSON.stringify(excludedVariables)}`,
  );
  return args;
}

function normalizedEvalPathPrepend(value) {
  if (!Array.isArray(value)) {
    throw new Error("execution_profile.path_prepend must be an array");
  }
  return value.map((item, index) => {
    const normalized = absoluteProfilePath(item, `execution_profile.path_prepend[${index}]`);
    if (normalized !== item) {
      throw new Error(`execution_profile.path_prepend[${index}] must be normalized`);
    }
    return normalized;
  });
}

function normalizedEvalAgentExecutable(value) {
  const normalized = absoluteProfilePath(
    value,
    "execution_profile.agent_executable",
  );
  if (normalized !== value) {
    throw new Error("execution_profile.agent_executable must be normalized");
  }
  return normalized;
}

function normalizedEvalAgentInterpreter(value) {
  if (value === undefined || value === null) return null;
  const normalized = absoluteProfilePath(
    value,
    "execution_profile.agent_interpreter",
  );
  if (normalized !== value) {
    throw new Error("execution_profile.agent_interpreter must be normalized");
  }
  return normalized;
}

function absoluteProfilePath(value, key) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path`);
  }
  return path.resolve(value);
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function parseCodexStdout(stdout) {
  const events = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonLine(line))
    .filter(Boolean);

  let threadId = null;
  let agentMessageEvent = null;
  let turnFailedEvent = null;
  let errorEvent = null;
  let turnCompletedEvent = null;
  for (const event of events) {
    if (
      event?.type === "thread.started" &&
      typeof event.thread_id === "string" &&
      event.thread_id.trim() !== ""
    ) {
      threadId = event.thread_id;
    } else if (
      event?.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      agentMessageEvent = event;
    } else if (event?.type === "turn.failed") {
      turnFailedEvent = event;
    } else if (event?.type === "error") {
      errorEvent = event;
    } else if (event?.type === "turn.completed") {
      turnCompletedEvent = event;
    }
  }

  return {
    raw: events,
    threadId,
    agentMessageEvent,
    turnFailedEvent,
    errorEvent,
    turnCompletedEvent,
    resultText: agentMessageEvent ? agentMessageEvent.item.text.trimEnd() : null,
    resultJson: agentMessageEvent,
    cliSessionRef: threadId
      ? { agent_id: CODEX_AGENT_ID, native_session_id: threadId }
      : null,
  };
}

export function interpretCodexExit({ code, signal, stdout, stderr }) {
  const parsed = parseCodexStdout(stdout);
  // A standalone error event followed by turn.completed was a retried stream
  // error; only treat it as terminal when the turn never completed.
  const failureEvent =
    parsed.turnFailedEvent ?? (parsed.turnCompletedEvent ? null : parsed.errorEvent);
  if (failureEvent) {
    const detail = codexFailureMessage(failureEvent);
    return {
      status: "failed",
      error: {
        code: "agent_error",
        message: detail.slice(0, TAIL_LIMIT),
        result_text: detail,
        result_json: failureEvent,
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
        message: `Codex exited with code ${code}${signal ? ` and signal ${signal}` : ""}`,
        exit_code: code,
        signal,
        stderr_tail: String(stderr ?? "").trimEnd().slice(-TAIL_LIMIT),
        cli_session_ref: parsed.cliSessionRef ?? undefined,
      },
    };
  }
  if (typeof parsed.resultText !== "string") {
    return failedParse(code, stdout, "Codex stdout did not include an agent_message item");
  }
  if (!parsed.cliSessionRef) {
    return failedParse(code, stdout, "Codex stdout did not include a thread.started thread_id");
  }
  return {
    status: "completed",
    resultText: parsed.resultText,
    resultJson: parsed.resultJson,
    cliSessionRef: parsed.cliSessionRef,
  };
}

export function codexSessionRefFromEvent(event) {
  const ref = sessionRefFromLiveEvent(CODEX_AGENT_ID, event);
  if (!ref) return null;
  try {
    assertCodexSessionId(ref.native_session_id);
    return ref;
  } catch {
    return null;
  }
}

export async function listCodexAgent(options = {}) {
  const availability = await getCodexAvailability();
  const catalog = availability.available
    ? await getCodexModelCatalog(options)
    : unavailableModelCatalog("agent CLI is unavailable");
  return {
    agent_id: CODEX_AGENT_ID,
    title: "Codex CLI",
    available: availability.available,
    version: availability.version,
    unavailable_reason: availability.available ? undefined : availability.reason,
    models: catalog.models,
    model_discovery: catalog.model_discovery,
    capabilities: {
      non_interactive: true,
      session_resume: true,
      command: "codex exec --json --skip-git-repo-check",
      discussion: CODEX_DISCUSSION_CAPABILITIES,
      evaluation: {
        supported: availability.available && supportsCodexEvalVersion(availability.version),
        command: "agenthub eval run --agent codex --model MODEL --effort LEVEL --cwd DIR --suite FILE",
        execution_profiles: Array.from(CODEX_EVAL_EXECUTION_PROFILES),
        answer_schemas: ["source-location/v1", "workspace-patch/v1"],
        minimum_version: CODEX_EVAL_MIN_VERSION.join("."),
        interactive: true,
      },
    },
  };
}

export async function getCodexModelCatalog({ cwd = process.cwd(), env = process.env } = {}) {
  const cacheKey = [cwd, env.CODEX_HOME ?? "", env.OPENAI_BASE_URL ?? ""].join("\0");
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAtMs < MODEL_CATALOG_CACHE_MS) {
    return cached.value;
  }
  const result = await runCommand("codex", ["debug", "models"], {
    cwd,
    env,
    timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
  });
  let value;
  if (result.error || result.code !== 0) {
    value = unavailableModelCatalog(commandFailureReason(result));
  } else {
    try {
      value = availableModelCatalog(parseCodexModelCatalog(result.stdout));
    } catch (error) {
      value = unavailableModelCatalog(error.message);
    }
  }
  modelCatalogCache.set(cacheKey, { checkedAtMs: Date.now(), value });
  return value;
}

export function parseCodexModelCatalog(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? ""));
  } catch {
    throw new Error("Codex model discovery returned invalid JSON");
  }
  if (!Array.isArray(parsed?.models)) {
    throw new Error("Codex model discovery response did not include a models array");
  }
  const models = parsed.models
    .filter(
      (model) =>
        model?.visibility === "list" &&
        typeof model.slug === "string" &&
        model.slug.trim() !== "",
    )
    .sort((left, right) => numericPriority(left.priority) - numericPriority(right.priority));
  return models.map((raw) => normalizeCodexModel(raw));
}

function normalizeCodexModel(raw) {
  const model = {
    id: raw.slug,
    display_name:
      typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name
        : raw.slug,
  };
  copyNonEmptyString(raw, "description", model, "description");
  copyNonEmptyString(raw, "default_reasoning_level", model, "default_effort");
  if (Number.isFinite(raw.priority)) {
    model.priority = raw.priority;
  }
  if (Number.isInteger(raw.context_window) && raw.context_window > 0) {
    model.context_window = raw.context_window;
  }
  const efforts = Array.isArray(raw.supported_reasoning_levels)
    ? raw.supported_reasoning_levels
        .map((entry) => entry?.effort)
        .filter((effort) => typeof effort === "string" && effort.trim() !== "")
    : [];
  if (efforts.length > 0) model.supported_efforts = efforts;
  const modalities = stringArray(raw.input_modalities);
  if (modalities.length > 0) model.input_modalities = modalities;
  if (raw.supports_reasoning_summaries === true) {
    model.capabilities = ["reasoning_summaries"];
  }
  return model;
}

function numericPriority(value) {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
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
  return `Codex model discovery exited with code ${result.code}`;
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

function assertCodexSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new Error("cli_session_ref.native_session_id must be a Codex thread UUID");
  }
}

function codexFailureMessage(failureEvent) {
  const message = failureEvent?.error?.message ?? failureEvent?.message;
  if (typeof message === "string" && message.trim() !== "") {
    return message.trim();
  }
  return "Codex reported a failed turn";
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

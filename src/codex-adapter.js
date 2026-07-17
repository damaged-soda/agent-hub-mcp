import path from "node:path";
import {
  assertMetadataString,
  defaultFromEnv,
  resolveUnifiedPermission,
  runVersionCommand,
} from "./adapter-utils.js";

export const CODEX_AGENT_ID = "codex";
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
// Codex thread ids are UUIDs. The resume session id is a positional argv value,
// so anything else (for example "--last") would be parsed as a codex option and
// could resume an unrelated session.
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_LIMIT = 4000;

let availabilityCache = null;

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

export function buildCodexCommand({ request, effectiveCliSessionRef, env = process.env }) {
  const resumed = effectiveCliSessionRef?.resumed === true;
  if (resumed) {
    assertCodexSessionId(effectiveCliSessionRef.native_session_id);
  }
  const usingResolvedMetadata = Boolean(request.resolved_metadata);
  const meta = request.resolved_metadata ?? request.metadata ?? {};
  const codex = meta.codex ?? {};

  const argv = ["codex", "exec"];
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
  // namespace and falls back to a server-side default instead of a unified field.
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

  // Read the prompt from stdin.
  argv.push("-");

  return {
    adapter_id: CODEX_AGENT_ID,
    command: argv[0],
    args: argv.slice(1),
    argv,
    output_format: "jsonl",
  };
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
  if (
    event?.type === "thread.started" &&
    typeof event.thread_id === "string" &&
    event.thread_id.trim() !== ""
  ) {
    return { agent_id: CODEX_AGENT_ID, native_session_id: event.thread_id };
  }
  return null;
}

export async function listCodexAgent() {
  const availability = await getCodexAvailability();
  return {
    agent_id: CODEX_AGENT_ID,
    title: "Codex CLI",
    available: availability.available,
    version: availability.version,
    unavailable_reason: availability.available ? undefined : availability.reason,
    capabilities: {
      non_interactive: true,
      session_resume: true,
      command: "codex exec --json --skip-git-repo-check",
      discussion: CODEX_DISCUSSION_CAPABILITIES,
    },
  };
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

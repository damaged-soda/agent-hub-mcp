import { spawn } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import path from "node:path";

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
const DEFAULT_PERMISSION_MODE = "auto";

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
  const result = await runCommand("claude", ["--version"], 5000);
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

function assertMetadataString(value, key) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

export function buildClaudeCommand({ request, effectiveCliSessionRef }) {
  if (
    !effectiveCliSessionRef ||
    typeof effectiveCliSessionRef.native_session_id !== "string" ||
    effectiveCliSessionRef.native_session_id.trim() === ""
  ) {
    throw new Error("effective_cli_session_ref.native_session_id must be a non-empty string");
  }
  const usingResolvedMetadata = Boolean(request.resolved_metadata);
  const claude = (request.resolved_metadata ?? request.metadata)?.claude ?? {};
  const argv = ["claude", "-p", "--input-format", "text", "--output-format", "json"];

  if (effectiveCliSessionRef?.resumed) {
    argv.push("--resume", effectiveCliSessionRef.native_session_id);
  } else {
    argv.push("--session-id", effectiveCliSessionRef.native_session_id);
  }

  const model = assertMetadataString(claude.model, "metadata.claude.model");
  if (model) {
    argv.push("--model", model);
  }

  const effort = assertMetadataString(claude.effort, "metadata.claude.effort");
  if (effort) {
    argv.push("--effort", effort);
  }

  const agent = assertMetadataString(claude.agent, "metadata.claude.agent");
  if (agent) {
    argv.push("--agent", agent);
  }

  const permissionMode =
    assertMetadataString(claude.permission_mode, "metadata.claude.permission_mode") ??
    DEFAULT_PERMISSION_MODE;
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
      command: "claude -p --input-format text --output-format json",
    },
  };
}

async function runCommand(command, args, timeoutMs) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  try {
    const result = await Promise.race([
      once(child, "close").then(([code, signal]) => ({ code, signal })),
      once(child, "error").then(([error]) => ({ code: null, signal: null, error })),
    ]);
    if (timedOut && !result.error) {
      result.error = new Error(`Timed out after ${timeoutMs}ms`);
    }
    return {
      ...result,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

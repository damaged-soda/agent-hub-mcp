import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLAUDE_SESSION_DIRECTORIES = Object.freeze([
  "projects",
  "session-env",
  "sessions",
]);
const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_RETRYABLE_CODES = new Set(["invalid_session_ref", "session_persistence_disabled"]);

export function claudeSessionRoot(env = process.env) {
  return path.resolve(env?.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

export async function preflightClaudeSessionPersistence({
  env = process.env,
  nativeSessionId,
  resumed = false,
} = {}) {
  const root = claudeSessionRoot(env);
  assertSessionId(nativeSessionId);
  if (env?.CLAUDE_CODE_SKIP_PROMPT_HISTORY === "1") {
    throw persistenceError(
      "session_persistence_disabled",
      "Claude session persistence is disabled by CLAUDE_CODE_SKIP_PROMPT_HISTORY",
    );
  }

  const existingTranscript = resumed
    ? await findClaudeTranscript(root, nativeSessionId)
    : null;
  if (resumed && !existingTranscript) {
    throw persistenceError(
      "session_resume_unavailable",
      `Claude session transcript was not found for ${nativeSessionId}`,
    );
  }

  for (const directory of CLAUDE_SESSION_DIRECTORIES) {
    await assertWritableDirectory(path.join(root, directory), nativeSessionId);
  }
  if (existingTranscript) {
    await assertAppendable(existingTranscript, "Claude session transcript");
  }

  return {
    root,
    transcript_path: existingTranscript,
  };
}

export async function verifyClaudeSessionPersistence({
  env = process.env,
  nativeSessionId,
} = {}) {
  const root = claudeSessionRoot(env);
  const transcriptPath = await findClaudeTranscript(root, nativeSessionId);
  if (!transcriptPath) {
    throw persistenceError(
      "session_persistence_failed",
      `Claude did not persist a transcript for session ${nativeSessionId}`,
    );
  }

  let stat;
  try {
    stat = await fsp.stat(transcriptPath);
  } catch (error) {
    throw persistenceError(
      "session_persistence_failed",
      `Claude session transcript became unavailable for ${nativeSessionId}: ${formatError(error)}`,
    );
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw persistenceError(
      "session_persistence_failed",
      `Claude session transcript is empty for ${nativeSessionId}`,
    );
  }

  return {
    root,
    transcript_path: transcriptPath,
    size_bytes: stat.size,
  };
}

async function findClaudeTranscript(root, nativeSessionId) {
  assertSessionId(nativeSessionId);
  const projectsRoot = path.join(root, "projects");
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw persistenceError(
      "session_store_unavailable",
      `Unable to inspect Claude session store ${projectsRoot}: ${formatError(error)}`,
    );
  }

  const filename = `${nativeSessionId}.jsonl`;
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const candidate = path.join(projectsRoot, projectDir.name, filename);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw persistenceError(
          "session_store_unavailable",
          `Unable to inspect Claude transcript ${candidate}: ${formatError(error)}`,
        );
      }
    }
  }
  return null;
}

async function assertWritableDirectory(directory, nativeSessionId) {
  let probePath;
  try {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    probePath = path.join(
      directory,
      `.agent-hub-session-probe-${nativeSessionId}-${crypto.randomUUID()}`,
    );
    const handle = await fsp.open(probePath, "wx", 0o600);
    await handle.close();
  } catch (error) {
    throw persistenceError(
      "session_store_unwritable",
      `Claude session store is not writable at ${directory}: ${formatError(error)}`,
    );
  } finally {
    if (probePath) await fsp.rm(probePath, { force: true }).catch(() => undefined);
  }
}

async function assertAppendable(filePath, label) {
  let handle;
  try {
    handle = await fsp.open(filePath, "a");
  } catch (error) {
    throw persistenceError(
      "session_store_unwritable",
      `${label} is not writable at ${filePath}: ${formatError(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function persistenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = !NON_RETRYABLE_CODES.has(code);
  return error;
}

function assertSessionId(nativeSessionId) {
  if (
    typeof nativeSessionId !== "string" ||
    !CLAUDE_SESSION_ID_PATTERN.test(nativeSessionId)
  ) {
    throw persistenceError(
      "invalid_session_ref",
      "Claude native session id must be a UUID",
    );
  }
}

function formatError(error) {
  if (!error) return "unknown error";
  const code = typeof error.code === "string" ? `${error.code}: ` : "";
  return `${code}${error.message || String(error)}`;
}

import { spawn } from "node:child_process";
import { once } from "node:events";

export function assertMetadataString(value, key) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

// Unified permission surface shared by all adapters. Each adapter maps these
// onto its CLI's native access control; the adapter's own metadata namespace
// (metadata.claude.permission_mode / metadata.codex.sandbox) takes precedence.
const UNIFIED_PERMISSIONS = new Set(["read-only", "auto", "full"]);

export function resolveUnifiedPermission(metadata) {
  const value = assertMetadataString(metadata?.permission, "metadata.permission");
  if (value === null) {
    return "auto";
  }
  if (!UNIFIED_PERMISSIONS.has(value)) {
    throw new Error(
      `metadata.permission must be one of: ${Array.from(UNIFIED_PERMISSIONS).join(", ")}`,
    );
  }
  return value;
}

export function defaultFromEnv(env, envKey) {
  const value = env?.[envKey];
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value.trim();
}

export async function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    input,
    maxOutputBytes = 8 * 1024 * 1024,
    timeoutMs = 5000,
  } = options;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let outputError = null;
  let timedOut = false;

  const collect = (chunks) => (chunk) => {
    const value = Buffer.from(chunk);
    outputBytes += value.length;
    if (outputBytes > maxOutputBytes) {
      outputError = new Error(`Command output exceeded ${maxOutputBytes} bytes`);
      child.kill("SIGKILL");
      return;
    }
    chunks.push(value);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  if (input !== undefined) {
    child.stdin.on("error", () => undefined);
    try {
      child.stdin.end(input);
    } catch (error) {
      outputError = error;
      child.kill("SIGKILL");
    }
  }

  try {
    const result = await Promise.race([
      // events.once rejects the "close" waiter when "error" fires first;
      // normalize that rejection into the same shape as the error branch.
      once(child, "close").then(
        ([code, signal]) => ({ code, signal }),
        (error) => ({ code: null, signal: null, error }),
      ),
      once(child, "error").then(([error]) => ({ code: null, signal: null, error })),
    ]);
    if (timedOut && !result.error) {
      result.error = new Error(`Timed out after ${timeoutMs}ms`);
    }
    if (outputError && !result.error) {
      result.error = outputError;
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

export function runVersionCommand(command, args, timeoutMs) {
  return runCommand(command, args, { timeoutMs });
}

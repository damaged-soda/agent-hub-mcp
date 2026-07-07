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

export function defaultModelFromEnv(env, envKey) {
  const value = env?.[envKey];
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value.trim();
}

export async function runVersionCommand(command, args, timeoutMs) {
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

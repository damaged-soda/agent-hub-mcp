#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteFile,
  atomicWriteJson,
  currentEnvKeys,
  expiresAt,
  FINAL_STATUSES,
  nowIso,
  readJsonIfExists,
  readJson,
  readState,
  syncAppend,
  updateStateGuarded,
  withStateLock,
  writeState,
} from "./fs-store.js";
import { buildClaudeCommand, parseClaudeJson, parseClaudeStdout } from "./claude-adapter.js";
import { buildAgentEnv } from "./env.js";

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    throw new Error("Usage: agent-hub-mcp-runner <run-dir>");
  }

  const request = await readJson(path.join(runDir, "request.json"));
  const startingPatch = {
    status: "starting",
    pid: process.pid,
    runner_pid: process.pid,
    runner_pgid: process.pid,
    started_at: nowIso(),
  };
  const startingState = await updateStateGuarded(runDir, startingPatch, {
    ifStatus: ["queued", "starting"],
  });
  if (FINAL_STATUSES.has(startingState.status)) {
    return;
  }

  const command = buildClaudeCommand({
    request,
    effectiveCliSessionRef: request.effective_cli_session_ref,
  });
  if ((await readState(runDir).catch(() => null))?.status === "cancelled") {
    return;
  }
  const agentEnv = buildAgentEnv(process.env);
  await atomicWriteJson(path.join(runDir, "command.json"), {
    schema_version: 1,
    adapter_id: command.adapter_id,
    argv: command.argv,
    cwd: request.cwd,
    env_keys: currentEnvKeys(agentEnv),
    runner_pid: process.pid,
    created_at: nowIso(),
  });

  await runCommand(runDir, request, command, agentEnv);
}

async function runCommand(runDir, request, command, agentEnv) {
  const input = await fsp.readFile(path.join(runDir, "input.txt"));
  const stdoutLog = fs.createWriteStream(path.join(runDir, "stdout.log"), {
    flags: "a",
    mode: 0o600,
  });
  const stderrLog = fs.createWriteStream(path.join(runDir, "stderr.log"), {
    flags: "a",
    mode: 0o600,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let logWriteError = null;
  let childPgid = null;
  let stdinError = null;
  let terminationRequested = false;
  const killTimers = [];
  const onLogError = (error) => {
    logWriteError = logWriteError ?? error;
    terminateChild(child, childPgid, killTimers);
  };

  const child = spawn(command.command, command.args, {
    cwd: request.cwd,
    detached: true,
    env: agentEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Node's POSIX detached spawn creates a new process group with pgid = child.pid.
  // verifyProcessGroup confirms that group exists before state exposes it.
  childPgid = child.pid;
  if (!Number.isInteger(childPgid) || childPgid <= 0) {
    throw new Error("Claude child process did not expose a pid");
  }
  try {
    verifyProcessGroup(childPgid);
  } catch (error) {
    terminateChild(child, childPgid, killTimers);
    throw error;
  }
  const signalHandler = () => {
    terminationRequested = true;
    terminateChild(child, childPgid, killTimers);
  };
  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);
  stdoutLog.on("error", onLogError);
  stderrLog.on("error", onLogError);

  let runningState;
  try {
    runningState = await updateStateGuarded(
      runDir,
      {
        status: "running",
        pid: child.pid,
        pgid: childPgid,
        runner_pid: process.pid,
        runner_pgid: process.pid,
        cli_pid: child.pid,
        cli_pgid: childPgid,
        cli_session_ref: publicCliSessionRef(request.effective_cli_session_ref),
      },
      { ifStatus: "starting" },
    );
  } catch (error) {
    terminateChild(child, childPgid, killTimers);
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
    throw error;
  }
  if (runningState.status !== "running") {
    terminateChild(child, childPgid, killTimers);
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
    return;
  }

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
    stdoutLog.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
    stderrLog.write(chunk);
  });
  child.stdin.on("error", (error) => {
    if (error?.code !== "EPIPE") {
      stdinError = stdinError ?? error;
      terminateChild(child, childPgid, killTimers);
    }
  });

  child.stdin.end(input);

  let code;
  let signal;
  let childProcessError = null;
  try {
    [code, signal] = await waitForChildExit(child);
  } catch (error) {
    if (error?.name !== "AbortError") {
      childProcessError = error;
    }
  } finally {
    for (const timer of killTimers) {
      clearTimeout(timer);
    }
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
    stdoutLog.end();
    stderrLog.end();
    await Promise.all([
      waitForWritableDone(stdoutLog),
      waitForWritableDone(stderrLog),
    ]);
  }

  const current = await readState(runDir).catch(() => null);
  if (current?.status === "cancelled") {
    return;
  }
  if (childProcessError) {
    await failRun(runDir, {
      code: "cli_spawn_failed",
      message: childProcessError instanceof Error ? childProcessError.message : String(childProcessError),
    });
    return;
  }
  if (terminationRequested) {
    await failRun(runDir, {
      code: "runner_terminated",
      message: "Runner received a termination signal",
      exit_code: code,
      signal,
    });
    return;
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (logWriteError) {
    await failRun(runDir, {
      code: "log_write_failed",
      message: logWriteError instanceof Error ? logWriteError.message : String(logWriteError),
      exit_code: code,
      signal,
    });
    return;
  }
  if (stdinError) {
    await failRun(runDir, {
      code: "stdin_write_failed",
      message: stdinError instanceof Error ? stdinError.message : String(stdinError),
      exit_code: code,
      signal,
    });
    return;
  }
  if (code !== 0) {
    await failRun(runDir, {
      code: "cli_exit_nonzero",
      message: `Claude exited with code ${code}${signal ? ` and signal ${signal}` : ""}`,
      exit_code: code,
      signal,
      stderr_tail: stderr.trimEnd().slice(-4000),
    });
    return;
  }

  try {
    const parsedJson = parseClaudeJson(stdout);

    if (parsedJson?.is_error === true) {
      const text =
        typeof parsedJson.result === "string"
          ? parsedJson.result.trimEnd()
          : "Claude returned is_error=true";
      await failRun(runDir, {
        code: "claude_is_error",
        message: "Claude returned is_error=true",
        result_text: text,
        result_json: parsedJson,
        exit_code: code,
        cli_session_ref:
          typeof parsedJson.session_id === "string"
            ? { agent_id: "claude-code", native_session_id: parsedJson.session_id }
            : publicCliSessionRef(request.effective_cli_session_ref),
      });
      return;
    }

    const parsed = parseClaudeStdout(parsedJson);
    await withStateLock(runDir, async () => {
      const currentState = await readJsonIfExists(path.join(runDir, "state.json"));
      if (currentState?.status !== "running") {
        return;
      }
      await atomicWriteJson(path.join(runDir, "result.json"), parsedJson);
      await atomicWriteFile(path.join(runDir, "result.txt"), parsed.resultText);
      await writeState(runDir, {
        ...currentState,
        status: "completed",
        exit_code: code,
        completed_at: nowIso(),
        updated_at: nowIso(),
        expires_at: expiresAt(),
        result_path: "result.txt",
        result_json_path: "result.json",
        cli_session_ref: parsed.cliSessionRef,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRun(runDir, {
      code: "stdout_parse_failed",
      message,
      exit_code: code,
      stdout_tail: stdout.trimEnd().slice(-4000),
    });
  }
}

async function failRun(runDir, error) {
  const stateError = sanitizeStateError(error);
  await withStateLock(runDir, async () => {
    const current = await readJsonIfExists(path.join(runDir, "state.json"));
    if (current?.status === "cancelled" || current?.status === "completed") {
      return;
    }
    await atomicWriteFile(path.join(runDir, "result.txt"), error.result_text ?? error.message);
    await atomicWriteJson(path.join(runDir, "result.json"), error.result_json ?? { error: stateError });
    const next = {
      ...(current ?? {}),
      status: "failed",
      exit_code: error.exit_code,
      signal: error.signal,
      completed_at: nowIso(),
      updated_at: nowIso(),
      expires_at: expiresAt(),
      error: stateError,
      result_path: "result.txt",
      result_json_path: "result.json",
    };
    if (error.cli_session_ref) {
      next.cli_session_ref = error.cli_session_ref;
    }
    await writeState(runDir, next);
  });
}

function sanitizeStateError(error) {
  const sanitized = { ...error };
  delete sanitized.stderr_tail;
  delete sanitized.stdout_tail;
  delete sanitized.result_json;
  delete sanitized.result_text;
  return sanitized;
}

function publicCliSessionRef(ref) {
  if (!ref) {
    return null;
  }
  return {
    agent_id: ref.agent_id,
    native_session_id: ref.native_session_id,
  };
}

function terminateChild(child, pgid, killTimers = []) {
  if (Number.isInteger(pgid) && pgid > 0) {
    try {
      process.kill(-pgid, "SIGTERM");
      const timer = setTimeout(() => {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") {
            throw error;
          }
        }
      }, 10000);
      timer.unref();
      killTimers.push(timer);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  child.kill("SIGTERM");
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    const onClose = (code, signal) => {
      cleanup();
      resolve([code, signal]);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function verifyProcessGroup(pgid) {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    throw new Error(`Detached child process group is not available: ${error.message}`);
  }
}

async function waitForWritableDone(stream) {
  if (stream.closed || stream.destroyed) {
    return;
  }
  await Promise.race([once(stream, "finish"), once(stream, "close"), once(stream, "error")]).catch(
    () => undefined,
  );
}

main().catch(async (error) => {
  const runDir = process.argv[2];
  const message = error instanceof Error ? error.message : String(error);
  if (runDir) {
    try {
      syncAppend(path.join(runDir, "stderr.log"), `${message}\n`);
      await failRun(runDir, {
        code: "runner_exception",
        message,
      });
    } catch (innerError) {
      const inner = innerError instanceof Error ? innerError.stack || innerError.message : String(innerError);
      process.stderr.write(`${message}\n${inner}\n`);
    }
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
});

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
import { getAdapter } from "./adapters.js";
import { buildBirthLaunch } from "./birth-command.js";
import { buildAgentEnv } from "./env.js";
import { reviewContextEnv } from "./review-context.js";

import {
  acquireSessionLease,
  completeSessionRun,
  releaseSessionRun,
} from "./session-registry.js";

const EVENT_STREAM_FORMATS = new Set(["stream-json", "jsonl"]);
const EARLY_SESSION_BUFFER_LIMIT = 65536;

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

  const adapter = getAdapter(request.agent_id);
  const command = adapter.buildCommand({
    request,
    effectiveCliSessionRef: request.effective_cli_session_ref,
  });
  const pathPrepend = normalizedCommandPathPrepend(command.path_prepend);
  if ((await readState(runDir).catch(() => null))?.status === "cancelled") {
    return;
  }
  const launchEnvironment =
    (await adapter.prepareLaunchEnvironment?.({ env: process.env })) ?? {};
  // 环境按白名单透传（会话轴状态 NS / NS_UNDO / PATH 整体在内），并置 NS_REBIND=1：
  // agent 经 zsh 起在 run 的 cwd，~/.zshenv 的 glue 先卸掉继承的域再按 cwd 绑定——和
  // 终端里敲命令同一条汇聚段，hub 不解析。command.env 是出生前覆盖；
  // command.post_birth_env 则在汇聚完成后由下面的私有 handoff 恢复。
  const baseAgentEnv = {
    ...buildAgentEnv(process.env),
    NS_REBIND: "1",
    ...(request.review_context ? reviewContextEnv(request.review_context) : {}),
    ...command.env,
  };
  for (const key of launchEnvironment.remove_env_keys ?? []) {
    delete baseAgentEnv[key];
  }
  const { env: agentEnv, launcher } = buildBirthLaunch(command, baseAgentEnv, {
    path_interpreter: command.path_interpreter,
    path_prepend: pathPrepend,
    post_birth_env: {
      ...(command.post_birth_env ?? {}),
      ...(launchEnvironment.post_birth_env ?? {}),
    },
    post_birth_unset: launchEnvironment.remove_env_keys,
  });
  const metadataArgv = commandArgvForMetadata(command.argv, request.execution_profile);
  const metadataLauncher = commandArgvForMetadata(launcher, request.execution_profile);
  await atomicWriteJson(path.join(runDir, "command.json"), {
    schema_version: 1,
    adapter_id: command.adapter_id,
    argv: metadataArgv,
    launcher: metadataLauncher,
    output_format: command.output_format,
    cwd: request.cwd,
    env_keys: currentEnvKeys(agentEnv),
    redactions: request.execution_profile?.kind === "workspace-write/v2"
      ? ["shell_environment_policy.set.*"]
      : undefined,
    runner_pid: process.pid,
    created_at: nowIso(),
  });

  await runCommand(runDir, request, adapter, command, agentEnv, launcher);
}

function commandArgvForMetadata(argv, executionProfile) {
  if (executionProfile?.kind !== "workspace-write/v2") return argv;
  return argv.map((item) => {
    if (typeof item !== "string") return item;
    const match = item.match(
      /^(shell_environment_policy\.set\.[A-Za-z_][A-Za-z0-9_]*=)/,
    );
    return match ? `${match[1]}"<redacted>"` : item;
  });
}

function normalizedCommandPathPrepend(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("command.path_prepend must be an array");
  return value.map((item, index) => {
    if (typeof item !== "string" || !path.isAbsolute(item)) {
      throw new Error(`command.path_prepend[${index}] must be absolute`);
    }
    if (item.includes(path.delimiter)) {
      throw new Error(`command.path_prepend[${index}] must not contain the PATH delimiter`);
    }
    const normalized = path.resolve(item);
    let real;
    try {
      real = fs.realpathSync(normalized);
      if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`command.path_prepend[${index}] must be an existing directory`);
    }
    if (real !== normalized) {
      throw new Error(`command.path_prepend[${index}] changed after profile validation`);
    }
    return real;
  });
}

async function runCommand(runDir, request, adapter, command, agentEnv, launcher) {
  const input = await fsp.readFile(path.join(runDir, "input.txt"));
  const stdoutLog = fs.createWriteStream(path.join(runDir, "stdout.log"), {
    flags: "a",
    mode: 0o600,
  });
  const stderrLog = fs.createWriteStream(path.join(runDir, "stderr.log"), {
    flags: "a",
    mode: 0o600,
  });
  const eventsLog = EVENT_STREAM_FORMATS.has(command.output_format)
    ? fs.createWriteStream(path.join(runDir, "events.jsonl"), {
        flags: "a",
        mode: 0o600,
      })
    : null;
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

  const child = spawn(launcher[0], launcher.slice(1), {
    cwd: request.cwd,
    detached: true,
    env: agentEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Node's POSIX detached spawn creates a new process group with pgid = child.pid.
  // verifyProcessGroup confirms that group exists before state exposes it.
  childPgid = child.pid;
  if (!Number.isInteger(childPgid) || childPgid <= 0) {
    throw new Error("Agent CLI child process did not expose a pid");
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
  eventsLog?.on("error", onLogError);

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

  // For adapters whose CLI assigns the session id itself (Codex thread_id),
  // capture it from the event stream as soon as it appears so cancelled runs
  // still expose a resumable cli_session_ref.
  let earlySessionDone =
    typeof adapter.sessionRefFromEvent !== "function" ||
    Boolean(publicCliSessionRef(request.effective_cli_session_ref));
  let earlySessionBuffer = "";
  let earlySessionRegistration = Promise.resolve();
  let earlySessionError = null;
  const captureEarlySessionRef = (chunk) => {
    earlySessionBuffer += chunk.toString("utf8");
    let newlineIndex;
    while (!earlySessionDone && (newlineIndex = earlySessionBuffer.indexOf("\n")) >= 0) {
      const line = earlySessionBuffer.slice(0, newlineIndex).trim();
      earlySessionBuffer = earlySessionBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const sessionRef = adapter.sessionRefFromEvent(event);
      if (sessionRef) {
        earlySessionDone = true;
        earlySessionBuffer = "";
        // "cancelled" is included so a cancel that wins the state lock right
        // after thread.started still ends up with a resumable session ref.
        earlySessionRegistration = (async () => {
          const state = await readState(runDir);
          const sessionRecord = await acquireSessionLease(sessionRef, {
            run_id: state.run_id,
          });
          try {
            const updated = await updateStateGuarded(
              runDir,
              {
                cli_session_ref: publicCliSessionRef(sessionRef),
                session_generation: sessionRecord.generation,
              },
              { ifStatus: ["running", "cancelled"] },
            );
            if (updated.status === "cancelled") {
              await completeSessionRun(sessionRef, state.run_id);
            }
          } catch (error) {
            await releaseSessionRun(sessionRef, state.run_id).catch(() => undefined);
            throw error;
          }
        })().catch((error) => {
          earlySessionError = error;
          terminateChild(child, childPgid, killTimers);
        });
      }
    }
    if (earlySessionBuffer.length > EARLY_SESSION_BUFFER_LIMIT) {
      earlySessionDone = true;
      earlySessionBuffer = "";
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
    stdoutLog.write(chunk);
    eventsLog?.write(chunk);
    if (!earlySessionDone) {
      captureEarlySessionRef(chunk);
    }
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
    eventsLog?.end();
    await Promise.all([
      waitForWritableDone(stdoutLog),
      waitForWritableDone(stderrLog),
      eventsLog ? waitForWritableDone(eventsLog) : undefined,
    ]);
  }

  await earlySessionRegistration;
  if (earlySessionError) {
    throw earlySessionError;
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
  const outcome = adapter.interpretExit({
    code,
    signal,
    stdout,
    stderr,
    outputFormat: command.output_format,
  });
  if (outcome.status !== "completed") {
    await failRun(runDir, outcome.error);
    return;
  }

  if (typeof adapter.verifySession === "function") {
    try {
      await adapter.verifySession({
        cwd: request.cwd,
        cliSessionRef: outcome.cliSessionRef,
        env: agentEnv,
      });
    } catch (error) {
      await failRun(runDir, {
        code: error?.code ?? "session_persistence_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: error?.retryable,
        result_text: outcome.resultText,
        result_json: outcome.resultJson,
        cli_session_ref: null,
        exit_code: code,
        signal,
      });
      return;
    }
  }

  const precompletedState = await readState(runDir).catch(() => null);
  const sessionRecord = await completeSessionRun(
    outcome.cliSessionRef,
    precompletedState?.run_id,
  ).catch(() => null);
  await withStateLock(runDir, async () => {
    const currentState = await readJsonIfExists(path.join(runDir, "state.json"));
    if (currentState?.status !== "running") {
      return;
    }
    await atomicWriteJson(path.join(runDir, "result.json"), outcome.resultJson);
    await atomicWriteFile(path.join(runDir, "result.txt"), outcome.resultText);
    const completedState = {
      ...currentState,
      status: "completed",
      exit_code: code,
      completed_at: nowIso(),
      updated_at: nowIso(),
      expires_at: expiresAt(),
      result_path: "result.txt",
      result_json_path: "result.json",
      cli_session_ref: outcome.cliSessionRef,
      session_generation: sessionRecord?.generation ?? currentState.session_generation,
      usage: normalizeUsage(outcome.resultJson),
    };
    await writeState(runDir, completedState);
  });
}

async function failRun(runDir, error) {
  const stateError = sanitizeStateError(error);
  const prefailedState = await readState(runDir).catch(() => null);
  const failedSessionRef = error.cli_session_ref ?? prefailedState?.cli_session_ref;
  const sessionRecord = await completeSessionRun(failedSessionRef, prefailedState?.run_id).catch(
    () => null,
  );
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
      retryable: stateError.retryable,
      session_generation: sessionRecord?.generation ?? current?.session_generation,
      result_path: "result.txt",
      result_json_path: "result.json",
    };
    if (Object.hasOwn(error, "cli_session_ref")) {
      next.cli_session_ref = publicCliSessionRef(error.cli_session_ref);
    }
    await writeState(runDir, next);
  });
}

function sanitizeStateError(error) {
  const sanitized = { ...error };
  if (looksLikeSessionResumeFailure(error)) {
    sanitized.code = "session_resume_failed";
  }
  delete sanitized.stderr_tail;
  delete sanitized.stdout_tail;
  delete sanitized.result_json;
  delete sanitized.result_text;
  sanitized.retryable =
    typeof error.retryable === "boolean"
      ? error.retryable
      : inferRetryable(
          sanitized.code,
          [error.message, error.stderr_tail, error.stdout_tail, error.result_text]
            .filter(Boolean)
            .join("\n"),
        );
  return sanitized;
}

function looksLikeSessionResumeFailure(error) {
  const text = [error?.message, error?.stderr_tail, error?.stdout_tail, error?.result_text]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (
    error?.agent_error_code === "authentication_failed" ||
    /(?:failed to authenticate|authentication failed|oauth)/.test(text)
  ) {
    return false;
  }
  return /(?:session|thread|conversation).*(?:not found|does not exist|unknown|expired)|(?:cannot|failed to) resume/.test(
    text,
  );
}

function inferRetryable(code, message) {
  const deterministicCodes = new Set([
    "runner_exception",
    "invalid_request",
    "unsupported_permission",
    "stdout_parse_failed",
  ]);
  if (deterministicCodes.has(code)) {
    return false;
  }
  const text = String(message ?? "").toLowerCase();
  if (/model .*not (?:found|configured)|invalid model|permission .*not supported|outside .*allowlist/.test(text)) {
    return false;
  }
  return new Set([
    "agent_error",
    "cli_spawn_failed",
    "runner_spawn_failed",
    "runner_terminated",
    "process_missing",
    "stdin_write_failed",
    "log_write_failed",
    "session_resume_failed",
    "session_store_unwritable",
    "session_persistence_failed",
    "session_resume_unavailable",
  ]).has(code);
}

function normalizeUsage(resultJson) {
  const usage = findUsage(resultJson);
  if (!usage) {
    return undefined;
  }
  const normalized = {
    input_tokens: finiteNumber(usage.input_tokens ?? usage.inputTokens),
    output_tokens: finiteNumber(usage.output_tokens ?? usage.outputTokens),
    cached_tokens: finiteNumber(
      usage.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cachedInputTokens,
    ),
    reported_cost: finiteNumber(usage.cost_usd ?? usage.total_cost_usd ?? usage.cost),
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function findUsage(value, depth = 0) {
  if (!value || depth > 4) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value) && value.usage) {
    return value.usage;
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findUsage(value[index], depth + 1);
      if (found) return found;
    }
  } else if (typeof value === "object") {
    for (const child of Object.values(value)) {
      const found = findUsage(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : undefined;
}

function publicCliSessionRef(ref) {
  if (!ref || typeof ref.native_session_id !== "string" || ref.native_session_id.trim() === "") {
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
        code: error?.code ?? "runner_exception",
        message,
        retryable: error?.retryable,
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

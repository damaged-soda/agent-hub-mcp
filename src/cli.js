#!/usr/bin/env node
import fsp from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  cancelAgentRun,
  dispatchToAgent,
  listAgents,
  queryAgentRun,
  runAgent,
  waitAgentRun,
} from "./runs.js";
import {
  cancelDiscussionFromCli,
  dispatchDiscussionFromCli,
  listDiscussionsFromCli,
  queryDiscussionFromCli,
  waitDiscussionFromCli,
} from "./discussion-cli.js";
import { dispatchReview, reviewStatus, setReviewRoute } from "./review-routing.js";
import { runEval } from "./eval-run.js";
import {
  installPythonRuntimeCapsule,
  pythonRuntimeCapsuleStatus,
} from "./eval-runtime.js";
import {
  evalToolchainCapsuleStatus,
  writeEvalToolchainCapsuleManifest,
} from "./eval-toolchain.js";

const HELP = `agenthub — run local coding agents without a resident daemon

Usage:
  agenthub agents [--cwd DIR]
  agenthub dispatch --agent ID [--cwd DIR] (--prompt TEXT | --prompt-file FILE)
  agenthub run      --agent ID [--cwd DIR] (--prompt TEXT | --prompt-file FILE)
  agenthub query RUN_ID
  agenthub wait RUN_ID [--timeout-ms MS]
  agenthub cancel RUN_ID [--reason TEXT] [--actor TEXT]
  agenthub review status [--cwd DIR]
  agenthub review set --requester ID --reviewer ID --model ID [--cwd DIR]
  agenthub review dispatch --requester ID [--cwd DIR] (--prompt TEXT | --prompt-file FILE)
  agenthub eval runtime install [--runtime ID]
  agenthub eval runtime status [--runtime ID]
  agenthub eval toolchain manifest --directory ABSOLUTE_DIR (--json JSON | --json-file FILE)
  agenthub eval toolchain status --toolchain ABSOLUTE_MANIFEST
  agenthub eval run --agent ID --model ID --effort LEVEL [--runtime ID_OR_ABSOLUTE_MANIFEST | --toolchain ABSOLUTE_MANIFEST] [--cwd DIR] [--suite FILE] [--timeout-ms MS]
  agenthub discussion dispatch (--json JSON | --json-file FILE)
  agenthub discussion list [--status STATUS[,STATUS]] [--since 7d] [--cwd DIR] [--limit N]
  agenthub discussion query DISCUSSION_ID [--after-sequence N] [--limit N]
  agenthub discussion wait DISCUSSION_ID [--timeout-ms MS] [--after-sequence N]
  agenthub discussion cancel DISCUSSION_ID [--reason TEXT] [--actor TEXT]

Run inputs:
  --metadata JSON         Adapter metadata object
  --session-id ID         Continue the selected agent's native session
  --json JSON             Supply the complete command input as JSON
  --json-file FILE        Read the complete command input from a file
  --prompt-file -         Read the prompt from stdin

Every successful command prints one JSON object to stdout. Errors print JSON to stderr.
`;

export async function main(argv = process.argv.slice(2), io = defaultIo()) {
  try {
    const value = await execute(argv, io);
    if (value !== undefined) io.stdout(`${JSON.stringify(value, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify({ error: serializeError(error) }, null, 2)}\n`);
    return 1;
  }
}

export async function execute(argv, io = defaultIo()) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(HELP);
    return undefined;
  }

  if (["agents", "list-agents", "list_agents"].includes(command)) {
    const parsed = parseArgs(args, new Set(["cwd", "json", "json-file"]));
    const raw = await rawInput(parsed.options);
    return listAgents(raw ?? { cwd: resolveOptionalPath(parsed.options.cwd) });
  }
  if (["dispatch", "dispatch-to-agent", "dispatch_to_agent"].includes(command)) {
    const parsed = parseRunCommand(args);
    return dispatchToAgent(await runInput(parsed, io));
  }
  if (["run", "run-agent", "run_agent"].includes(command)) {
    const parsed = parseRunCommand(args, ["timeout-ms", "poll-interval-ms"]);
    const input = await runInput(parsed, io);
    setOptionalNumber(input, "timeout_ms", parsed.options["timeout-ms"], { positive: true });
    setOptionalNumber(input, "poll_interval_ms", parsed.options["poll-interval-ms"], {
      positive: true,
    });
    return runAgent(input);
  }
  if (["query", "query-run", "query_agent_run"].includes(command)) {
    const parsed = parseArgs(args, new Set(["run-id", "json", "json-file"]));
    return queryAgentRun(await runRefInput(parsed));
  }
  if (["wait", "wait-run", "wait_agent_run"].includes(command)) {
    const parsed = parseArgs(
      args,
      new Set(["run-id", "timeout-ms", "poll-interval-ms", "json", "json-file"]),
    );
    const input = await runRefInput(parsed);
    setOptionalNumber(input, "timeout_ms", parsed.options["timeout-ms"], { positive: true });
    setOptionalNumber(input, "poll_interval_ms", parsed.options["poll-interval-ms"], {
      positive: true,
    });
    return waitAgentRun(input);
  }
  if (["cancel", "cancel-run", "cancel_agent_run"].includes(command)) {
    const parsed = parseArgs(
      args,
      new Set(["run-id", "reason", "actor", "json", "json-file"]),
    );
    const input = await runRefInput(parsed);
    if (parsed.options.reason !== undefined) input.reason = parsed.options.reason;
    if (parsed.options.actor !== undefined) input.actor = parsed.options.actor;
    return cancelAgentRun(input);
  }
  if (command === "review") return executeReview(args, io);
  if (command === "eval") return executeEval(args, io);
  if (command === "discussion") return executeDiscussion(args);

  throw usageError(`Unknown command: ${command}`);
}

async function executeEval(args, io) {
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { usage: HELP };
  }
  if (command === "runtime") return executeEvalRuntime(args);
  if (command === "toolchain") return executeEvalToolchain(args);
  if (command !== "run") throw usageError(`Unknown eval command: ${command}`);
  const parsed = parseArgs(
    args,
    new Set([
      "agent", "cwd", "suite", "model", "effort", "runtime", "toolchain", "timeout-ms",
    ]),
  );
  rejectPositionals(parsed);
  const input = {
    agent_id: required(parsed.options.agent, "--agent is required"),
    model: required(parsed.options.model, "--model is required"),
    effort: required(parsed.options.effort, "--effort is required"),
    cwd: path.resolve(parsed.options.cwd ?? process.cwd()),
  };
  if (parsed.options.suite !== undefined) input.suite_path = parsed.options.suite;
  if (parsed.options.runtime !== undefined) input.runtime = parsed.options.runtime;
  if (parsed.options.toolchain !== undefined) input.toolchain = parsed.options.toolchain;
  setOptionalNumber(input, "timeout_ms", parsed.options["timeout-ms"], { positive: true });
  try {
    return await runEval(input, io);
  } finally {
    io.closeInput?.();
  }
}

async function executeEvalToolchain(args) {
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { usage: HELP };
  }
  if (command === "manifest") {
    const parsed = parseArgs(args, new Set(["directory", "json", "json-file"]));
    rejectPositionals(parsed);
    const input = await requiredRawInput(
      parsed.options,
      "Eval toolchain manifest requires --json or --json-file",
    );
    const allowed = new Set(["toolchain_id", "platform", "arch", "root", "commands"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw usageError(
        "Eval toolchain manifest input accepts only toolchain_id, platform, arch, root, and commands",
      );
    }
    const manifestPath = await writeEvalToolchainCapsuleManifest(
      required(parsed.options.directory, "--directory is required"),
      {
        ...input,
        platform: input.platform ?? process.platform,
        arch: input.arch ?? process.arch,
      },
    );
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    return {
      status: "written",
      manifest_path: manifestPath,
      toolchain: {
        kind: manifest.kind,
        toolchain_id: manifest.toolchain_id,
        content_digest: manifest.content_digest,
        platform: manifest.platform,
        arch: manifest.arch,
        root: manifest.root,
        commands: manifest.commands,
      },
    };
  }
  if (command !== "status") {
    throw usageError(`Unknown eval toolchain command: ${command}`);
  }
  const parsed = parseArgs(args, new Set(["toolchain"]));
  rejectPositionals(parsed);
  return evalToolchainCapsuleStatus(
    required(parsed.options.toolchain, "--toolchain is required"),
    process.env,
    { require_sealed: true },
  );
}

async function executeEvalRuntime(args) {
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { usage: HELP };
  }
  if (command !== "install" && command !== "status") {
    throw usageError(`Unknown eval runtime command: ${command}`);
  }
  const parsed = parseArgs(args, new Set(["runtime"]));
  rejectPositionals(parsed);
  return command === "install"
    ? installPythonRuntimeCapsule(parsed.options.runtime ?? "default", process.env)
    : pythonRuntimeCapsuleStatus(parsed.options.runtime ?? "default", process.env);
}

async function executeReview(args, io) {
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { usage: HELP };
  }
  if (command === "status") {
    const parsed = parseArgs(args, new Set(["cwd"]));
    rejectPositionals(parsed);
    return reviewStatus({ cwd: path.resolve(parsed.options.cwd ?? process.cwd()) });
  }
  if (command === "set") {
    const parsed = parseArgs(args, new Set(["requester", "reviewer", "model", "cwd"]));
    rejectPositionals(parsed);
    return setReviewRoute({
      requester: required(parsed.options.requester, "--requester is required"),
      reviewer: required(parsed.options.reviewer, "--reviewer is required"),
      model: required(parsed.options.model, "--model is required"),
      cwd: path.resolve(parsed.options.cwd ?? process.cwd()),
    });
  }
  if (command === "dispatch") {
    const parsed = parseArgs(
      args,
      new Set(["requester", "cwd", "prompt", "prompt-file"]),
    );
    rejectPositionals(parsed);
    return dispatchReview({
      requester: required(parsed.options.requester, "--requester is required"),
      cwd: path.resolve(parsed.options.cwd ?? process.cwd()),
      prompt: await readPrompt(parsed.options, io),
    });
  }
  throw usageError(`Unknown review command: ${command}`);
}

async function executeDiscussion(args) {
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { usage: HELP };
  }
  if (["dispatch", "dispatch_discussion"].includes(command)) {
    const parsed = parseArgs(args, new Set(["json", "json-file"]));
    const input = await requiredRawInput(parsed.options, "Discussion dispatch requires --json or --json-file");
    return dispatchDiscussionFromCli(input);
  }
  if (["list", "list_discussions"].includes(command)) {
    const parsed = parseArgs(
      args,
      new Set(["status", "since", "cwd", "limit", "json", "json-file"]),
    );
    const raw = await rawInput(parsed.options);
    if (raw) return listDiscussionsFromCli(raw);
    rejectPositionals(parsed);
    const input = {};
    if (parsed.options.status !== undefined) input.status = parsed.options.status;
    if (parsed.options.since !== undefined) input.since = parsed.options.since;
    if (parsed.options.cwd !== undefined) input.cwd = resolveExistingOrLexicalPath(parsed.options.cwd);
    setOptionalNumber(input, "limit", parsed.options.limit, { positive: true });
    return listDiscussionsFromCli(input);
  }
  if (["query", "query_discussion"].includes(command)) {
    const parsed = parseArgs(
      args,
      new Set(["discussion-id", "after-sequence", "limit", "json", "json-file"]),
    );
    return queryDiscussionFromCli(await discussionRefInput(parsed));
  }
  if (["wait", "wait_discussion"].includes(command)) {
    const parsed = parseArgs(
      args,
      new Set([
        "discussion-id",
        "timeout-ms",
        "after-sequence",
        "limit",
        "json",
        "json-file",
      ]),
    );
    const input = await discussionRefInput(parsed);
    return waitDiscussionFromCli(input, {
      timeout_ms: optionalNumber(
        parsed.options["timeout-ms"] ?? input.timeout_ms,
        "--timeout-ms",
        { positive: true },
      ),
    });
  }
  if (["cancel", "cancel_discussion"].includes(command)) {
    const parsed = parseArgs(
      args,
      new Set(["discussion-id", "reason", "actor", "json", "json-file"]),
    );
    const input = await discussionRefInput(parsed);
    if (parsed.options.reason !== undefined) input.reason = parsed.options.reason;
    if (parsed.options.actor !== undefined) input.actor = parsed.options.actor;
    return cancelDiscussionFromCli(input);
  }
  throw usageError(`Unknown discussion command: ${command}`);
}

function parseRunCommand(args, extra = []) {
  return parseArgs(
    args,
    new Set([
      "agent",
      "cwd",
      "prompt",
      "prompt-file",
      "metadata",
      "session-id",
      "json",
      "json-file",
      ...extra,
    ]),
  );
}

async function runInput(parsed, io) {
  const raw = await rawInput(parsed.options);
  if (raw) return raw;
  const agentId = required(parsed.options.agent, "--agent is required");
  const prompt = await readPrompt(parsed.options, io);
  const input = {
    agent_id: agentId,
    prompt,
    cwd: path.resolve(parsed.options.cwd ?? process.cwd()),
  };
  if (parsed.options.metadata !== undefined) {
    input.metadata = parseJson(parsed.options.metadata, "--metadata");
  }
  if (parsed.options["session-id"] !== undefined) {
    input.cli_session_ref = {
      agent_id: agentId,
      native_session_id: parsed.options["session-id"],
    };
  }
  return input;
}

async function runRefInput(parsed) {
  const raw = await rawInput(parsed.options);
  if (raw) return raw;
  const runId = parsed.options["run-id"] ?? parsed.positionals[0];
  required(runId, "RUN_ID or --run-id is required");
  if (parsed.positionals.length > 1) throw usageError("Too many positional arguments");
  return { run_ref: { run_id: runId } };
}

async function discussionRefInput(parsed) {
  const raw = await rawInput(parsed.options);
  if (raw) return raw;
  const discussionId = parsed.options["discussion-id"] ?? parsed.positionals[0];
  required(discussionId, "DISCUSSION_ID or --discussion-id is required");
  if (parsed.positionals.length > 1) throw usageError("Too many positional arguments");
  const input = { discussion_ref: { discussion_id: discussionId } };
  setOptionalNumber(input, "after_sequence", parsed.options["after-sequence"]);
  setOptionalNumber(input, "limit", parsed.options.limit, { positive: true });
  return input;
}

async function readPrompt(options, io) {
  if (options.prompt !== undefined && options["prompt-file"] !== undefined) {
    throw usageError("Use only one of --prompt and --prompt-file");
  }
  if (options.prompt !== undefined) return options.prompt;
  if (options["prompt-file"] === "-") return io.readStdin();
  if (options["prompt-file"] !== undefined) {
    return fsp.readFile(path.resolve(options["prompt-file"]), "utf8");
  }
  throw usageError("--prompt or --prompt-file is required");
}

function parseArgs(argv, allowed) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!allowed.has(name)) throw usageError(`Unknown option: ${token}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`${token} requires a value`);
    }
    if (Object.hasOwn(options, name)) throw usageError(`${token} may only be provided once`);
    options[name] = value;
  }
  return { options, positionals };
}

function rejectPositionals(parsed) {
  if (parsed.positionals.length) throw usageError("Unexpected positional arguments");
}

async function rawInput(options) {
  if (options.json !== undefined && options["json-file"] !== undefined) {
    throw usageError("Use only one of --json and --json-file");
  }
  if (options.json !== undefined) return parseJson(options.json, "--json");
  if (options["json-file"] !== undefined) {
    return parseJson(
      await fsp.readFile(path.resolve(options["json-file"]), "utf8"),
      "--json-file",
    );
  }
  return null;
}

async function requiredRawInput(options, message) {
  const input = await rawInput(options);
  if (!input) throw usageError(message);
  return input;
}

function parseJson(value, flag) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw usageError(`${flag} is invalid: ${error.message}`);
  }
}

function setOptionalNumber(target, key, value, options) {
  const parsed = optionalNumber(value, `--${key.replaceAll("_", "-")}`, options);
  if (parsed !== undefined) target[key] = parsed;
}

function optionalNumber(value, flag, options = {}) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (options.positive ? parsed <= 0 : parsed < 0)) {
    throw usageError(
      `${flag} must be a ${options.positive ? "positive" : "non-negative"} integer`,
    );
  }
  return parsed;
}

function resolveOptionalPath(value) {
  return value === undefined ? undefined : path.resolve(value);
}

function resolveExistingOrLexicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function required(value, message) {
  if (value === undefined || value === "") throw usageError(message);
  return value;
}

function usageError(message) {
  const error = new Error(message);
  error.code = "invalid_cli_usage";
  return error;
}

function serializeError(error) {
  const serialized = {
    code: error?.code ?? "agenthub_error",
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.retryable === "boolean") {
    serialized.retryable = error.retryable;
  }
  return serialized;
}

function defaultIo() {
  let promptInterface = null;
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    readStdin: async () => {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    readLine: async (prompt) => {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        const error = new Error("agenthub eval run requires an interactive terminal");
        error.code = "interactive_eval_required";
        throw error;
      }
      promptInterface ??= readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
      return questionUntilClosed(promptInterface, prompt);
    },
    closeInput: () => {
      promptInterface?.close();
      promptInterface = null;
    },
  };
}

export function questionUntilClosed(promptInterface, prompt) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      promptInterface.removeListener("close", onClose);
      fn(value);
    };
    const onClose = () => {
      const error = new Error("Interactive eval input closed before all answers were collected");
      error.code = "interactive_eval_required";
      finish(reject, error);
    };
    promptInterface.once("close", onClose);
    promptInterface.question(prompt).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}

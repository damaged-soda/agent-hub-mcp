#!/usr/bin/env node
import fsp from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
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
  queryDiscussionFromCli,
  waitDiscussionFromCli,
} from "./discussion-cli.js";

const HELP = `agenthub — run local coding agents without a resident daemon

Usage:
  agenthub agents [--cwd DIR]
  agenthub dispatch --agent ID [--cwd DIR] (--prompt TEXT | --prompt-file FILE)
  agenthub run      --agent ID [--cwd DIR] (--prompt TEXT | --prompt-file FILE)
  agenthub query RUN_ID
  agenthub wait RUN_ID [--timeout-ms MS]
  agenthub cancel RUN_ID [--reason TEXT] [--actor TEXT]
  agenthub discussion dispatch (--json JSON | --json-file FILE)
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
  if (command === "discussion") return executeDiscussion(args);

  throw usageError(`Unknown command: ${command}`);
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
  return {
    code: error?.code ?? "agenthub_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function defaultIo() {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    readStdin: async () => {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}

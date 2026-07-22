import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_PATH = path.resolve("src/cli.js");

describe("agenthub CLI", () => {
  let root;
  let workspace;
  let env;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-cli-test-"));
    workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(bin, { recursive: true });
    await writeFakeClaude(path.join(bin, "claude"));
    env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      AGENT_HUB_RUN_DIR: path.join(root, "runs"),
      AGENT_HUB_DISCUSSION_DIR: path.join(root, "discussions"),
      AGENT_HUB_CWD_ALLOWLIST: workspace,
    };
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("dispatches and waits across separate CLI processes", async () => {
    const accepted = await runCli(
      [
        "dispatch",
        "--agent",
        "claude-code",
        "--cwd",
        workspace,
        "--prompt",
        "review this",
      ],
      env,
    );

    expect(accepted.status).toBe("accepted");
    const completed = await runCli(
      ["wait", accepted.run_ref.run_id, "--timeout-ms", "10000"],
      env,
    );

    expect(completed.status).toBe("completed");
    expect(completed.content[0].text).toBe("fake result: review this");
  });

  it("runs a durable discussion from a detached CLI worker", async () => {
    const staleCommandDir = path.join(
      env.AGENT_HUB_DISCUSSION_DIR,
      ".cli-commands",
      "stale-command",
    );
    await fsp.mkdir(staleCommandDir, { recursive: true });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(staleCommandDir, staleAt, staleAt);
    const requestPath = path.join(root, "discussion.json");
    await fsp.writeFile(
      requestPath,
      JSON.stringify({
        kind: "new",
        objective: "validate CLI discussions",
        question: "Does the detached coordinator complete?",
        cwd: workspace,
        materials: [],
        host: { agent_id: "claude-code", metadata: {} },
        participants: [
          {
            participant_id: "reviewer-a",
            agent_id: "claude-code",
            role: "reliability reviewer",
            focus: "process lifecycle",
            metadata: {},
          },
          {
            participant_id: "reviewer-b",
            agent_id: "claude-code",
            role: "protocol reviewer",
            focus: "durability",
            metadata: {},
          },
        ],
        quorum: 2,
      }),
      { mode: 0o600 },
    );

    const accepted = await runCli(
      ["discussion", "dispatch", "--json-file", requestPath],
      env,
    );
    expect(accepted.status).toBe("accepted");
    await expect(fsp.access(staleCommandDir)).rejects.toThrow();

    const completed = await runCli(
      [
        "discussion",
        "wait",
        accepted.discussion_ref.discussion_id,
        "--timeout-ms",
        "30000",
      ],
      env,
      40000,
    );

    expect(completed.status).toBe("completed");
    expect(completed.protocol_integrity).toBe("complete");
    expect(completed.run_refs).toHaveLength(8);
  }, 40000);

  it("resumes a discussion after its detached coordinator is killed", async () => {
    const requestPath = path.join(root, "recoverable-discussion.json");
    await writeDiscussionRequest(requestPath, workspace);
    const delayedEnv = { ...env, FAKE_CLAUDE_DELAY_MS: "300" };
    const accepted = await runCli(
      ["discussion", "dispatch", "--json-file", requestPath],
      delayedEnv,
    );
    const discussionId = accepted.discussion_ref.discussion_id;
    const leasePath = path.join(
      delayedEnv.AGENT_HUB_DISCUSSION_DIR,
      discussionId,
      "lease.json",
    );
    const lease = await waitForJson(leasePath);
    process.kill(lease.pid, "SIGKILL");
    await waitForProcessExit(lease.pid);

    const completed = await runCli(
      ["discussion", "wait", discussionId, "--timeout-ms", "30000"],
      delayedEnv,
      40000,
    );
    if (completed.status !== "completed") {
      const workerLog = await fsp
        .readFile(path.join(delayedEnv.AGENT_HUB_DISCUSSION_DIR, ".workers.log"), "utf8")
        .catch(() => "<missing worker log>");
      throw new Error(
        `Recovered discussion stayed ${completed.status}: ${JSON.stringify(completed.error)}\n${workerLog}`,
      );
    }
    expect(completed.status).toBe("completed");
    expect(completed.protocol_integrity).toBe("complete");
    expect(completed.run_refs).toHaveLength(8);
  }, 45000);
});

async function writeDiscussionRequest(target, workspace) {
  await fsp.writeFile(
    target,
    JSON.stringify({
      kind: "new",
      objective: "validate CLI discussion recovery",
      question: "Does the detached coordinator recover?",
      cwd: workspace,
      materials: [],
      host: { agent_id: "claude-code", metadata: {} },
      participants: [
        {
          participant_id: "reviewer-a",
          agent_id: "claude-code",
          role: "reliability reviewer",
          focus: "process lifecycle",
          metadata: {},
        },
        {
          participant_id: "reviewer-b",
          agent_id: "claude-code",
          role: "protocol reviewer",
          focus: "durability",
          metadata: {},
        },
      ],
      quorum: 2,
    }),
    { mode: 0o600 },
  );
}

async function waitForJson(target, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fsp.readFile(target, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for JSON file: ${target}`);
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function runCli(args, childEnv, timeoutMs = 15000) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: path.dirname(path.dirname(CLI_PATH)),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  if (code !== 0) throw new Error(`CLI exited ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  return JSON.parse(out);
}

async function writeFakeClaude(target) {
  await fsp.writeFile(
    target,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.193 (Claude Code)\\n");
  process.exit(0);
}
const outputIndex = args.indexOf("--output-format");
const streamJson = outputIndex >= 0 && args[outputIndex + 1] === "stream-json";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0)));
  let controlRequest = null;
  try { controlRequest = JSON.parse(input.trim()); } catch {}
  if (controlRequest?.type === "control_request") {
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: controlRequest.request_id,
        response: { models: [{ value: "haiku", resolvedModel: "fake-haiku" }] }
      }
    }) + "\\n");
    return;
  }
  const sessionIndex = args.indexOf("--session-id");
  const resumeIndex = args.indexOf("--resume");
  const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : args[resumeIndex + 1];
  const write = (value) => process.stdout.write(JSON.stringify(value) + (streamJson ? "\\n" : ""));
  if (streamJson) write({ type: "system", subtype: "init", session_id: sessionId });
  let result = "fake result: " + input;
  if (input.includes("AGENT_HUB_DISCUSSION_PROTOCOL_V1")) {
    const marker = "[OUTPUT CONTRACT]\\n";
    const markerIndex = input.lastIndexOf(marker);
    result = input.slice(markerIndex + marker.length).trim();
  }
  if (streamJson) {
    write({ type: "assistant", message: { content: [{ type: "text", text: result }] }, session_id: sessionId });
    write({ type: "result", subtype: "success", result, session_id: sessionId, is_error: false });
  } else {
    write({ result, session_id: sessionId, is_error: false });
  }
});
`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

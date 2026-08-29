import { spawn } from "node:child_process";
import fs from "node:fs";
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
      AGENT_HUB_REVIEW_CONFIG: path.join(root, "config", "review-routing.json"),
      AGENT_HUB_CWD_ALLOWLIST: workspace,
    };
  });

  afterEach(async () => {
    await fsp.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
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

  it("births the agent through zsh at the run cwd with NS_REBIND=1 and records the real launcher argv", async () => {
    // 假 ZDOTDIR：.zshenv 只记录出生 cwd 与收到的会话轴状态（真实 glue 的契约由下一条用真 ns-resolve 验）
    const zdot = path.join(root, "zdot");
    await fsp.mkdir(zdot, { recursive: true });
    await fsp.writeFile(path.join(zdot, ".zshenv"), 'export BORN_CWD="$PWD"\nexport NS="glue-saw-${NS:-none}"\n');
    const accepted = await runCli(
      ["dispatch", "--agent", "claude-code", "--cwd", workspace, "--prompt", "dump-env"],
      { ...env, NS: "caller-domain", NS_UNDO: "unset NS", LEAK: "from-caller", ZDOTDIR: zdot, AGENT_HUB_FORWARD_ENV: "ZDOTDIR", AGENT_HUB_REQUIRE_NAMESPACE: "1" },
    );
    expect(accepted.status).toBe("accepted");
    const completed = await runCli(["wait", accepted.run_ref.run_id, "--timeout-ms", "10000"], env);
    expect(completed.status).toBe("completed");
    expect(JSON.parse(completed.content[0].text)).toEqual({
      NS: "glue-saw-caller-domain", NS_UNDO: "unset NS", NS_REBIND: "1",
      BORN_CWD: await fsp.realpath(workspace), LEAK: null,
    });
    const command = JSON.parse(await fsp.readFile(path.join(env.AGENT_HUB_RUN_DIR, accepted.run_ref.run_id, "command.json"), "utf8"));
    expect(command.launcher.slice(0, 3)).toEqual(["/bin/zsh", "-c", 'exec "$0" "$@"']);
    expect(command.launcher.slice(3)).toEqual(command.argv);
  });

  // 真实契约：用 charter 的 ns-resolve 当 glue（本机 ~/ns/.charter，或 AGENT_HUB_TEST_NS_RESOLVE 指定；
  // 不支持 NS_REBIND 的旧版或缺位时跳过）。假 HOME 下造两个域，调用方带着 A 域派发到 B 域仓：
  // agent 必须看到 B 的域变量、看不到 A 的、看不到 NS_REBIND。
  const realResolver = process.env.AGENT_HUB_TEST_NS_RESOLVE ?? path.join(os.homedir(), "ns", ".charter", "scripts", "ns-resolve");
  const resolverSupportsRebind = fs.existsSync(realResolver) && fs.readFileSync(realResolver, "utf8").includes("NS_REBIND");
  it.skipIf(!resolverSupportsRebind)("with charter's real ns-resolve as glue: inherited domain unloaded, run-cwd domain bound, marker consumed", async () => {
    const fakeHome = path.join(root, "fake-home");
    // 域判据文件两种布局都造（charter 2026-08-22 质料树重切前 github/config/git-identity、后 git/identity），
    // 让本判例对重切前后的 ns-resolve 都成立
    for (const d of ["da", "db"]) {
      for (const marker of [["github", "config", "git-identity"], ["git", "identity"]]) {
        await fsp.mkdir(path.join(fakeHome, "ns", d, ...marker.slice(0, -1)), { recursive: true });
        await fsp.writeFile(path.join(fakeHome, "ns", d, ...marker), "");
      }
      await fsp.mkdir(path.join(fakeHome, "ns", d, "bin"), { recursive: true });
      await fsp.writeFile(path.join(fakeHome, "ns", d, "env"), `export ${d.toUpperCase()}_FLAG=on\n`);
      await fsp.mkdir(path.join(fakeHome, "work", d), { recursive: true });
    }
    await fsp.mkdir(path.join(fakeHome, "ns", ".charter", "scripts"), { recursive: true });
    await fsp.symlink(realResolver, path.join(fakeHome, "ns", ".charter", "scripts", "ns-resolve"));
    await fsp.writeFile(path.join(fakeHome, ".zshenv"), 'eval "$("$HOME/ns/.charter/scripts/ns-resolve" --shell=zsh)"\n');
    const target = path.join(fakeHome, "work", "db");
    await fsp.mkdir(path.join(target, "repo"), { recursive: true });
    // 调用方带着 da 域：NS_UNDO 是 ns-resolve 当初绑定 da 时记下的撤销语句（含精确剥段）
    const daBin = path.join(fakeHome, "ns", "da", "bin");
    const callerEnv = { ...env, HOME: fakeHome, AGENT_HUB_CWD_ALLOWLIST: target, NS: "da", NS_UNDO: `unset DA_FLAG;unset NS;__ns_path_strip lit '${daBin}'`, DA_FLAG: "on", PATH: `${daBin}:${env.PATH}` };
    const accepted = await runCli(["dispatch", "--agent", "claude-code", "--cwd", path.join(target, "repo"), "--prompt", "dump-env2"], callerEnv);
    expect(accepted.status).toBe("accepted");
    const completed = await runCli(["wait", accepted.run_ref.run_id, "--timeout-ms", "15000"], callerEnv);
    expect(completed.status).toBe("completed");
    const seen = JSON.parse(completed.content[0].text);
    expect(seen.NS).toBe("db");
    expect(seen.DB_FLAG).toBe("on");
    expect(seen.DA_FLAG).toBeNull();
    expect(seen.NS_REBIND).toBeNull();
    expect(seen.PATH.split(":")).toContain(path.join(fakeHome, "ns", "db", "bin"));
    expect(seen.PATH.split(":")).not.toContain(path.join(fakeHome, "ns", "da", "bin"));
  });

  it("returns structured errors for invalid CLI input", async () => {
    const invalidTimeout = await runCliFailure(
      ["wait", "not-used", "--timeout-ms", "0"],
      env,
    );
    expect(invalidTimeout).toEqual({
      error: {
        code: "invalid_cli_usage",
        message: "--timeout-ms must be a positive integer",
      },
    });

    const invalidJson = await runCliFailure(["dispatch", "--json", "{"], env);
    expect(invalidJson.error.code).toBe("invalid_cli_usage");
    expect(invalidJson.error.message).toMatch(/^--json is invalid:/);
  });

  it("writes structured worker diagnostics for a rejected Discussion preflight", async () => {
    const rejected = await runCliFailure(
      [
        "discussion",
        "dispatch",
        "--json",
        JSON.stringify({
          kind: "new",
          objective: "invalid request",
          question: "missing roster",
          cwd: workspace,
          materials: [],
        }),
      ],
      env,
    );
    expect(rejected.error.message).toMatch(/Invalid input/);

    const logPath = path.join(env.AGENT_HUB_DISCUSSION_DIR, ".workers.log");
    const records = await waitForWorkerLog(logPath, "worker.failed");
    expect(records.every((record) => record.schema_version === 1 && record.timestamp)).toBe(true);
    expect(records.at(-1)).toMatchObject({
      event: "worker.failed",
      mode: "dispatch",
      discussion_id: null,
      error: { code: "discussion_worker_error" },
    });
    expect(JSON.stringify(records)).not.toContain("stack");
  });

  it("persists a review route and dispatches with its configured model", async () => {
    const initial = await runCli(["review", "status", "--cwd", workspace], env);
    expect(initial.kind).toBe("agent-review-config");
    expect(initial.routes.find((route) => route.requester === "codex")).toMatchObject({
      reviewer: "claude-code",
      model: "default",
      source: "default",
    });

    const updated = await runCli([
      "review", "set",
      "--requester", "codex",
      "--reviewer", "claude-code",
      "--model", "haiku",
      "--cwd", workspace,
    ], env);
    expect(updated.routes.find((route) => route.requester === "codex")).toMatchObject({
      reviewer: "claude-code",
      model: "haiku",
      source: "override",
    });

    const accepted = await runCli([
      "review", "dispatch",
      "--requester", "codex",
      "--cwd", workspace,
      "--prompt", "review via route",
    ], env);
    const completed = await runCli(
      ["wait", accepted.run_ref.run_id, "--timeout-ms", "10000"],
      env,
    );
    expect(completed.status).toBe("completed");
    expect(completed.content[0].text).toBe("fake result: review via route");
    const command = JSON.parse(await fsp.readFile(
      path.join(env.AGENT_HUB_RUN_DIR, accepted.run_ref.run_id, "command.json"),
      "utf8",
    ));
    expect(command.argv).toContain("haiku");
  }, 15000);

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
        budget_profile: "quick",
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
    expect(completed.completion_quality).toBe("complete");
    expect(completed.budget_status).toMatchObject({
      profile: "quick",
      total_ms: 30 * 60 * 1000,
      repair_min_ms: 2 * 60 * 1000,
    });
    expect(completed.run_refs).toHaveLength(8);

    const listed = await runCli(
      [
        "discussion",
        "list",
        "--status",
        "completed",
        "--since",
        "7d",
        "--cwd",
        workspace,
        "--limit",
        "1",
      ],
      env,
    );
    expect(listed).toMatchObject({
      kind: "agent-discussion-list",
      total_matching: 1,
      has_more: false,
      discussions: [
        {
          discussion_ref: accepted.discussion_ref,
          status: "completed",
          completion_quality: "complete",
          budget_status: { profile: "quick" },
        },
      ],
    });

    const workerRecords = (await fsp.readFile(
      path.join(env.AGENT_HUB_DISCUSSION_DIR, ".workers.log"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(workerRecords.some((record) =>
      record.event === "discussion.accepted" &&
      record.discussion_id === accepted.discussion_ref.discussion_id
    )).toBe(true);
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

async function waitForWorkerLog(target, event, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const records = (await fsp.readFile(target, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (records.some((record) => record.event === event)) return records;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for worker log event ${event}: ${target}`);
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
  const { code, out, err } = await invokeCli(args, childEnv, timeoutMs);
  if (code !== 0) throw new Error(`CLI exited ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  return JSON.parse(out);
}

async function runCliFailure(args, childEnv, timeoutMs = 15000) {
  const { code, out, err } = await invokeCli(args, childEnv, timeoutMs);
  if (code === 0) throw new Error(`CLI unexpectedly succeeded\nstdout:\n${out}`);
  return JSON.parse(err);
}

async function invokeCli(args, childEnv, timeoutMs) {
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
  return { code, out, err };
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
  if (input.trim() === "dump-env") {
    result = JSON.stringify({ NS: process.env.NS ?? null, NS_UNDO: process.env.NS_UNDO ?? null, NS_REBIND: process.env.NS_REBIND ?? null, BORN_CWD: process.env.BORN_CWD ?? null, LEAK: process.env.LEAK ?? null });
  }
  if (input.trim() === "dump-env2") {
    result = JSON.stringify({ NS: process.env.NS ?? null, DA_FLAG: process.env.DA_FLAG ?? null, DB_FLAG: process.env.DB_FLAG ?? null, NS_REBIND: process.env.NS_REBIND ?? null, PATH: process.env.PATH ?? "" });
  }
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

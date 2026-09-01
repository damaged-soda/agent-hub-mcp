import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchToAgent, waitAgentRun } from "../src/runs.js";

describe("internal run idempotency", () => {
  let root;
  let workspace;
  let claudeConfigDir;
  let previous;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "run-idempotency-"));
    workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(bin, { recursive: true });
    claudeConfigDir = path.join(root, "claude");
    await fsp.mkdir(claudeConfigDir, { recursive: true });
    await fsp.writeFile(
      path.join(bin, "claude"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2.1.193 (Claude Code)\\n"); process.exit(0); }
const index = args.indexOf("--session-id");
const sessionId = index >= 0 ? args[index + 1] : args[args.indexOf("--resume") + 1];
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const transcriptDir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-agenthub-test");
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.appendFileSync(
    path.join(transcriptDir, sessionId + ".jsonl"),
    JSON.stringify({ type: "system", session_id: sessionId }) + "\\n",
  );
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: input }] }, session_id: sessionId }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: input, session_id: sessionId, is_error: false }) + "\\n");
});
`,
      { mode: 0o755 },
    );
    previous = {
      PATH: process.env.PATH,
      AGENT_HUB_RUN_DIR: process.env.AGENT_HUB_RUN_DIR,
      AGENT_HUB_CWD_ALLOWLIST: process.env.AGENT_HUB_CWD_ALLOWLIST,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.AGENT_HUB_RUN_DIR = path.join(root, "runs");
    process.env.AGENT_HUB_CWD_ALLOWLIST = workspace;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  });

  afterEach(async () => {
    restore(previous);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("returns the same run for the same request and rejects key reuse with a new hash", async () => {
    const input = {
      agent_id: "claude-code",
      prompt: "same prompt",
      cwd: workspace,
      cli_session_ref: null,
      metadata: {},
    };
    const internal = { idempotency_key: "discussion:test:turn:memo:a:attempt:1" };
    const first = await dispatchToAgent(input, internal);
    const repeated = await dispatchToAgent(input, internal);
    expect(repeated.run_ref).toEqual(first.run_ref);

    await expect(
      dispatchToAgent({ ...input, prompt: "different prompt" }, internal),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const terminal = await waitAgentRun({
      run_ref: first.run_ref,
      timeout_ms: 5000,
      poll_interval_ms: 10,
    });
    expect(terminal.status).toBe("completed");
  });

  it("rejects dispatch before creating a run when Claude's native store is not writable", async () => {
    const projects = path.join(claudeConfigDir, "projects");
    await fsp.mkdir(projects, { recursive: true });
    await fsp.chmod(projects, 0o500);

    await expect(
      dispatchToAgent({
        agent_id: "claude-code",
        prompt: "should not start",
        cwd: workspace,
        cli_session_ref: null,
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: "session_store_unwritable" });

    await fsp.chmod(projects, 0o700);
    const runEntries = await fsp.readdir(path.join(root, "runs"));
    expect(runEntries.filter((entry) => entry !== ".internal")).toEqual([]);
  });
});

function restore(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

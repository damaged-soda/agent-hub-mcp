import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callAgentHubTool } from "../scripts/mcp-client.js";

describe("MCP flow", () => {
  let tempDir;
  let binDir;
  let runDir;
  let workspaceDir;
  let env;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-test-"));
    binDir = path.join(tempDir, "bin");
    runDir = path.join(tempDir, "runs");
    workspaceDir = path.join(tempDir, "workspace");
    await fsp.mkdir(binDir, { recursive: true });
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(path.join(workspaceDir, "subdir"), { recursive: true });
    await fsp.writeFile(path.join(workspaceDir, "README.md"), "# Fixture\n");
    await writeFakeClaude(path.join(binDir, "claude"));
    env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      AGENT_HUB_RUN_DIR: runDir,
      AGENT_HUB_CWD_ALLOWLIST: workspaceDir,
    };
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it("runs list_agents and run_agent end to end over MCP stdio", async () => {
    const listed = await callAgentHubTool("list_agents", {}, { env });
    expect(listed.structuredContent.agents).toHaveLength(1);
    expect(listed.structuredContent.agents[0].agent_id).toBe("claude-code");

    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "claude-code",
        prompt: "review this",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: {
          claude: {
            model: "sonnet",
            effort: "medium",
            add_dirs: ["subdir"],
          },
        },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("completed");
    expect(result.content[0].text).toBe("fake result: review this");
    expect(result.structuredContent.cli_session_ref.native_session_id).toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const command = JSON.parse(
      await fsp.readFile(
        path.join(
          runDir,
          result.structuredContent.run_ref.run_id,
          "command.json",
        ),
        "utf8",
      ),
    );
    expect(command.argv.slice(0, 5)).toEqual([
      "claude",
      "-p",
      "--input-format",
      "text",
      "--output-format",
    ]);
    expect(command.argv).toContain("stream-json");
    expect(command.argv).toContain("--verbose");
    expect(command.argv).toContain("--permission-mode");
    expect(command.argv).toContain("auto");
    expect(command.argv).toContain(await fsp.realpath(path.join(workspaceDir, "subdir")));
    expect(command.env_keys).toContain("PATH");
    expect(result.structuredContent.artifacts.map((artifact) => artifact.path)).toContain(
      "events.jsonl",
    );
  });

  it("returns failed run content directly instead of JSON-wrapping it", async () => {
    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "claude-code",
        prompt: "error",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { claude: {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("failed");
    expect(result.content[0].text).toBe("fake failure");
    expect(result.content[0].text.trim().startsWith("{")).toBe(false);
    expect(result.structuredContent.cli_session_ref.native_session_id).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("cancels a run even when cancellation races with runner startup", async () => {
    const accepted = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "claude-code",
        prompt: "sleep",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { claude: {} },
      },
      { env },
    );

    const cancelled = await callAgentHubTool(
      "cancel_agent_run",
      {
        run_ref: accepted.structuredContent.run_ref,
        reason: "test cleanup",
        actor: "vitest",
      },
      { env },
    );

    expect(cancelled.structuredContent.status).toBe("cancelled");
    expect(cancelled.content[0].text).toBe("Run cancelled.");
    expect(cancelled.structuredContent.cancel_reason).toBe("test cleanup");
    expect(cancelled.structuredContent.cancel_actor).toBe("vitest");

    const queried = await callAgentHubTool(
      "query_agent_run",
      {
        run_ref: accepted.structuredContent.run_ref,
      },
      { env },
    );
    expect(queried.structuredContent.status).toBe("cancelled");
    expect(queried.structuredContent.cancel_reason).toBe("test cleanup");
  });

  it("reconciles stale active runs before cancel", async () => {
    const staleRunDir = path.join(runDir, "stale-run");
    await fsp.mkdir(staleRunDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      path.join(staleRunDir, "state.json"),
      JSON.stringify(
        {
          schema_version: 1,
          run_id: "stale-run",
          agent_id: "claude-code",
          status: "running",
          pid: 99999999,
          pgid: 99999999,
          cwd: workspaceDir,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 604800000).toISOString(),
        },
        null,
        2,
      ),
    );

    const result = await callAgentHubTool(
      "cancel_agent_run",
      {
        run_ref: { run_id: "stale-run" },
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("failed");
    expect(result.structuredContent.error.code).toBe("process_missing");
  });

  it("terminates the process group for a running cancellation", async () => {
    const accepted = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "claude-code",
        prompt: "sleep",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { claude: {} },
      },
      { env },
    );

    const runId = accepted.structuredContent.run_ref.run_id;
    const pgid = await waitForRunPgid(runDir, runId);
    const cancelled = await callAgentHubTool(
      "cancel_agent_run",
      {
        run_ref: { run_id: runId },
      },
      { env },
    );

    expect(cancelled.structuredContent.status).toBe("cancelled");
    await waitForProcessGroupGone(pgid);
  });

  it("returns a running snapshot when wait_agent_run times out", async () => {
    const accepted = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "claude-code",
        prompt: "sleep",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { claude: {} },
      },
      { env },
    );
    await waitForRunPgid(runDir, accepted.structuredContent.run_ref.run_id);
    await waitForEventLog(runDir, accepted.structuredContent.run_ref.run_id);

    const queried = await callAgentHubTool(
      "query_agent_run",
      {
        run_ref: accepted.structuredContent.run_ref,
      },
      { env },
    );
    expect(queried.structuredContent.status).toBe("running");
    expect(queried.content[0].text).toContain("poll again");
    expect(queried.structuredContent.poll_after_ms).toBe(1000);
    expect(queried.structuredContent.progress_events.at(-1).message).toContain(
      "fake progress",
    );

    const waited = await callAgentHubTool(
      "wait_agent_run",
      {
        run_ref: accepted.structuredContent.run_ref,
        timeout_ms: 100,
        poll_interval_ms: 50,
      },
      { env },
    );
    expect(waited.structuredContent.status).toBe("running");
    expect(waited.structuredContent.timed_out).toBe(true);
    expect(waited.structuredContent.poll_after_ms).toBe(1000);

    await callAgentHubTool(
      "cancel_agent_run",
      {
        run_ref: accepted.structuredContent.run_ref,
      },
      { env },
    );
  });

  it("passes cli_session_ref through to Claude as --resume", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "claude-code",
        prompt: "resume",
        cwd: workspaceDir,
        cli_session_ref: {
          agent_id: "claude-code",
          native_session_id: sessionId,
        },
        metadata: { claude: {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );

    const command = JSON.parse(
      await fsp.readFile(
        path.join(
          runDir,
          result.structuredContent.run_ref.run_id,
          "command.json",
        ),
        "utf8",
      ),
    );
    expect(command.argv).toContain("--resume");
    expect(command.argv).toContain(sessionId);
    expect(command.argv).not.toContain("--session-id");
  });

  it("rejects cwd outside AGENT_HUB_CWD_ALLOWLIST", async () => {
    const result = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "claude-code",
        prompt: "review this",
        cwd: tempDir,
        cli_session_ref: null,
        metadata: { claude: {} },
      },
      { env },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside AGENT_HUB_CWD_ALLOWLIST/);
  });

  it("returns an MCP error for an unknown run id", async () => {
    const result = await callAgentHubTool(
      "query_agent_run",
      {
        run_ref: { run_id: "doesnotexist" },
      },
      { env },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown run_id/);
  });
});

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
const outputFormat = outputIndex >= 0 ? args[outputIndex + 1] : "json";
const streamJson = outputFormat === "stream-json";
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const sessionIndex = args.indexOf("--session-id");
  const resumeIndex = args.indexOf("--resume");
  const sessionId =
    sessionIndex >= 0 ? args[sessionIndex + 1] :
    resumeIndex >= 0 ? args[resumeIndex + 1] :
    "550e8400-e29b-41d4-a716-446655440000";
  const writeJson = (value) => {
    process.stdout.write(JSON.stringify(value));
    if (streamJson) {
      process.stdout.write("\\n");
    }
  };
  const writeInit = () => {
    if (!streamJson) {
      return;
    }
    writeJson({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "fake-model"
    });
  };
  const writeAssistant = (text) => {
    if (!streamJson) {
      return;
    }
    writeJson({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
      session_id: sessionId
    });
  };
  const writeResult = (result, isError = false) => {
    if (streamJson) {
      writeJson({
        type: "result",
        subtype: isError ? "error" : "success",
        result,
        session_id: sessionId,
        is_error: isError
      });
      return;
    }
    writeJson({
      result,
      session_id: sessionId,
      is_error: isError
    });
  };
  if (input.trim() === "sleep") {
    writeInit();
    writeAssistant("fake progress");
    setTimeout(() => {
      writeResult("late result");
    }, 30000);
    return;
  }
  writeInit();
  if (input.trim() === "error") {
    writeAssistant("fake failure");
    writeResult("fake failure", true);
    return;
  }
  writeAssistant("fake result: " + input);
  writeResult("fake result: " + input);
});
`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

async function waitForEventLog(root, runId) {
  const eventsPath = path.join(root, runId, "events.jsonl");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const text = await fsp.readFile(eventsPath, "utf8").catch(() => "");
    if (text.includes("fake progress")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("run did not write progress events");
}

async function waitForRunPgid(root, runId) {
  const statePath = path.join(root, runId, "state.json");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const state = JSON.parse(await fsp.readFile(statePath, "utf8"));
    if (state.status === "running" && Number.isInteger(state.pgid)) {
      return state.pgid;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("run did not reach running state");
}

function isProcessGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroupGone(pgid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process group ${pgid} is still alive`);
}

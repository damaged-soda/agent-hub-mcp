import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callAgentHubTool,
  callAgentHubToolHttp,
  cleanEnv,
  defaultServerPath,
  repoRoot,
} from "../scripts/mcp-client.js";
import { waitAgentRun } from "../src/runs.js";

const FAKE_CODEX_THREAD_ID = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000";
const FAKE_KIMI_SESSION_ID = "session_0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000";
const FAKE_OPENCODE_SESSION_ID = "ses_0199aaaabbbb4ccc8dddeeeeffff0000";

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
    await writeFakeCodex(path.join(binDir, "codex"));
    await writeFakeKimi(path.join(binDir, "kimi"));
    await writeFakeOpenCode(path.join(binDir, "opencode"));
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
    const listed = await callAgentHubTool("list_agents", { cwd: workspaceDir }, { env });
    expect(listed.structuredContent.agents.map((agent) => agent.agent_id)).toEqual([
      "claude-code",
      "codex",
      "kimi-code",
      "opencode",
    ]);
    const listedById = Object.fromEntries(
      listed.structuredContent.agents.map((agent) => [agent.agent_id, agent]),
    );
    expect(listedById["claude-code"].model_discovery.status).toBe("available");
    expect(listedById["claude-code"].models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sonnet",
          resolved_id: "claude-sonnet-test",
          supported_efforts: ["low", "high"],
        }),
      ]),
    );
    expect(listedById.codex.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gpt-test-codex", priority: 1 }),
      ]),
    );
    expect(listedById["kimi-code"].models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "kimi-code/test", context_window: 131072 }),
      ]),
    );
    expect(JSON.stringify(listedById["kimi-code"])).not.toContain("secret-provider-key");
    expect(listedById.opencode.models).toEqual([
      {
        id: "zai-coding-plan/glm-5.3-flash",
        display_name: "zai-coding-plan/glm-5.3-flash",
      },
    ]);

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

  it("runs list_agents over MCP streamable HTTP", async () => {
    await withAgentHubHttpServer(env, async (url) => {
      const listed = await callAgentHubToolHttp("list_agents", {}, url, {
        requestTimeoutMs: 30000,
      });

      expect(listed.structuredContent.agents.map((agent) => agent.agent_id)).toEqual([
        "claude-code",
        "codex",
        "kimi-code",
        "opencode",
      ]);
    });
  });

  it("keeps discussion tools HTTP-only and completes the fixed protocol", async () => {
    const stdioTools = await listAgentHubTools({ env });
    expect(stdioTools.tools.map((tool) => tool.name)).not.toContain("dispatch_discussion");

    await withAgentHubHttpServer(env, async (url) => {
      const httpTools = await listAgentHubToolsHttp(url);
      expect(httpTools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "dispatch_discussion",
          "query_discussion",
          "wait_discussion",
          "cancel_discussion",
        ]),
      );

      const accepted = await callAgentHubToolHttp(
        "dispatch_discussion",
        {
          kind: "new",
          objective: "Decide whether the fixed discussion protocol works",
          question: "Should this implementation ship?",
          cwd: workspaceDir,
          materials: [
            {
              material_id: "brief",
              type: "inline",
              title: "Brief",
              content: "Use the frozen five-phase protocol.",
            },
          ],
          host: { agent_id: "claude-code", metadata: {} },
          participants: [
            {
              participant_id: "reviewer-a",
              agent_id: "claude-code",
              role: "reliability reviewer",
              focus: "recovery and idempotency",
              metadata: {},
            },
            {
              participant_id: "reviewer-b",
              agent_id: "claude-code",
              role: "protocol reviewer",
              focus: "schema and evidence",
              metadata: {},
            },
          ],
          quorum: 2,
          budget_profile: "research",
        },
        url,
        { requestTimeoutMs: 30000 },
      );

      expect(accepted.structuredContent.status).toBe("accepted");
      const completed = await callAgentHubToolHttp(
        "wait_discussion",
        { discussion_ref: accepted.structuredContent.discussion_ref },
        url,
        { requestTimeoutMs: 30000 },
      );

      expect(completed.structuredContent.status).toBe("completed");
      expect(completed.structuredContent.protocol_integrity).toBe("complete");
      expect(completed.structuredContent.budget_status).toMatchObject({
        profile: "research",
        total_ms: 90 * 60 * 1000,
        repair_min_ms: 2 * 60 * 1000,
      });
      expect(completed.structuredContent.run_refs).toHaveLength(8);
      expect(completed.structuredContent.decision.recommendation.summary).toBe("string");
      expect(completed.content[0].text).toMatch(/^# Discussion Decision/m);
      const discussionId = accepted.structuredContent.discussion_ref.discussion_id;
      const discussionDir = path.join(tempDir, "discussions", discussionId);
      await expect(fsp.stat(path.join(discussionDir, "decision.json"))).resolves.toBeDefined();
      await expect(fsp.stat(path.join(discussionDir, "decision.md"))).resolves.toBeDefined();

      const followUp = await callAgentHubToolHttp(
        "dispatch_discussion",
        {
          kind: "follow_up",
          parent_discussion_ref: accepted.structuredContent.discussion_ref,
          question: "Does the prior decision still hold with one new constraint?",
          materials: [
            {
              material_id: "new-constraint",
              type: "inline",
              title: "New constraint",
              content: "The participant roster must stay unchanged.",
            },
          ],
        },
        url,
        { requestTimeoutMs: 30000 },
      );
      const followUpCompleted = await callAgentHubToolHttp(
        "wait_discussion",
        { discussion_ref: followUp.structuredContent.discussion_ref },
        url,
        { requestTimeoutMs: 30000 },
      );
      expect(followUpCompleted.structuredContent.status).toBe("completed");
      expect(followUpCompleted.structuredContent.budget_status.profile).toBe("research");
      expect(followUpCompleted.structuredContent.run_refs).toHaveLength(8);
      expect(
        followUpCompleted.structuredContent.participant_statuses.map((member) => member.session_mode),
      ).toEqual(["resumed", "resumed"]);
      const followUpState = JSON.parse(
        await fsp.readFile(
          path.join(
            tempDir,
            "discussions",
            followUp.structuredContent.discussion_ref.discussion_id,
            "state.json",
          ),
          "utf8",
        ),
      );
      expect(followUpState.parent_discussion_ref).toEqual(accepted.structuredContent.discussion_ref);
      await expect(
        fsp.stat(
          path.join(
            tempDir,
            "discussions",
            followUp.structuredContent.discussion_ref.discussion_id,
            "handoff/context.json",
          ),
        ),
      ).resolves.toBeDefined();
    });
  }, 45000);

  it("returns HTTP errors for wrong streamable HTTP routes", async () => {
    await withAgentHubHttpServer(env, async (url) => {
      const wrongPath = await fetch(url.replace("/mcp", "/not-mcp"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(wrongPath.status).toBe(404);

      const wrongMethod = await fetch(url);
      expect(wrongMethod.status).toBe(405);
    });
  });

  it("rejects browser origins unless they are explicitly allowed", async () => {
    await withAgentHubHttpServer(env, async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: "{}",
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: -32003, message: "Forbidden origin" },
      });
    });
  });

  it("rejects non-loopback streamable HTTP hosts", async () => {
    const port = await getFreePort();
    const result = await runAgentHubServerExpectFailure(
      [
        "--transport",
        "streamable-http",
        "--host",
        "0.0.0.0",
        "--port",
        String(port),
      ],
      env,
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--host must be a loopback host/);
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

  it("prevents a continuation while its CLI session is still active", async () => {
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

    const conflicting = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "claude-code",
        prompt: "continue too early",
        cwd: workspaceDir,
        cli_session_ref: accepted.structuredContent.cli_session_ref,
        metadata: { claude: {} },
      },
      { env },
    );
    expect(conflicting.isError).toBe(true);
    expect(conflicting.content[0].text).toMatch(/session is active/i);

    await callAgentHubTool(
      "cancel_agent_run",
      { run_ref: accepted.structuredContent.run_ref },
      { env },
    );
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

  it("exposes wait_agent_run with only run_ref input", async () => {
    const listed = await listAgentHubTools({ env });
    const waitTool = listed.tools.find((tool) => tool.name === "wait_agent_run");

    expect(waitTool).toBeDefined();
    expect(waitTool.inputSchema.required).toEqual(["run_ref"]);
    expect(waitTool.inputSchema.properties).toHaveProperty("run_ref");
    expect(waitTool.inputSchema.properties).not.toHaveProperty("timeout_ms");
    expect(waitTool.inputSchema.properties).not.toHaveProperty("poll_interval_ms");
  });

  it("ignores legacy wait_agent_run timing fields over MCP stdio", async () => {
    const accepted = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "claude-code",
        prompt: "review this",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { claude: {} },
      },
      { env },
    );

    const result = await callAgentHubTool(
      "wait_agent_run",
      {
        run_ref: accepted.structuredContent.run_ref,
        timeout_ms: 100,
        poll_interval_ms: 50,
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("completed");
    expect(result.content[0].text).toBe("fake result: review this");
  });

  it("returns a running snapshot when internal waitAgentRun times out", async () => {
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

    const waited = await withRunDir(runDir, () =>
      waitAgentRun({
        run_ref: accepted.structuredContent.run_ref,
        timeout_ms: 100,
        poll_interval_ms: 50,
      }),
    );
    expect(waited.status).toBe("running");
    expect(waited.timed_out).toBe(true);
    expect(waited.poll_after_ms).toBe(1000);

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

  it("runs a codex agent end to end and discovers the thread id", async () => {
    const accepted = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "codex",
        prompt: "review this",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: {
          codex: {
            model: "gpt-5.2-codex",
            effort: "high",
            add_dirs: ["subdir"],
          },
        },
      },
      { env },
    );
    expect(accepted.structuredContent.cli_session_ref).toBeNull();

    const result = await withRunDir(runDir, () =>
      waitAgentRun({
        run_ref: accepted.structuredContent.run_ref,
        timeout_ms: 5000,
        poll_interval_ms: 50,
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.content[0].text).toBe("fake codex result: review this");
    expect(result.cli_session_ref).toEqual({
      agent_id: "codex",
      native_session_id: FAKE_CODEX_THREAD_ID,
    });

    const command = JSON.parse(
      await fsp.readFile(
        path.join(runDir, accepted.structuredContent.run_ref.run_id, "command.json"),
        "utf8",
      ),
    );
    expect(command.argv.slice(0, 4)).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
    ]);
    expect(command.argv).toContain("--model");
    expect(command.argv).toContain("gpt-5.2-codex");
    expect(command.argv).toContain('model_reasoning_effort="high"');
    expect(command.argv).toContain("--sandbox");
    expect(command.argv).toContain("workspace-write");
    expect(command.argv).toContain("sandbox_workspace_write.network_access=true");
    expect(command.argv).toContain(await fsp.realpath(path.join(workspaceDir, "subdir")));
    expect(command.argv.at(-1)).toBe("-");
    expect(command.output_format).toBe("jsonl");
  });

  it("passes codex cli_session_ref through to codex exec resume", async () => {
    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "codex",
        prompt: "continue",
        cwd: workspaceDir,
        cli_session_ref: {
          agent_id: "codex",
          native_session_id: FAKE_CODEX_THREAD_ID,
        },
        metadata: { codex: {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("completed");
    expect(result.structuredContent.cli_session_ref.native_session_id).toBe(
      FAKE_CODEX_THREAD_ID,
    );

    const command = JSON.parse(
      await fsp.readFile(
        path.join(runDir, result.structuredContent.run_ref.run_id, "command.json"),
        "utf8",
      ),
    );
    expect(command.argv.slice(0, 4)).toEqual(["codex", "exec", "resume", FAKE_CODEX_THREAD_ID]);
    expect(command.argv).toContain('sandbox_mode="workspace-write"');
    expect(command.argv).not.toContain("--sandbox");
  });

  it("runs a kimi agent end to end and discovers the session id", async () => {
    const accepted = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "kimi-code",
        prompt: "review this",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: {
          "kimi-code": {
            model: "k2",
            effort: "high",
            add_dirs: ["subdir"],
          },
        },
      },
      { env },
    );
    expect(accepted.structuredContent.cli_session_ref).toBeNull();

    const result = await withRunDir(runDir, () =>
      waitAgentRun({
        run_ref: accepted.structuredContent.run_ref,
        timeout_ms: 5000,
        poll_interval_ms: 50,
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.content[0].text).toBe("fake kimi result: review this");
    expect(result.cli_session_ref).toEqual({
      agent_id: "kimi-code",
      native_session_id: FAKE_KIMI_SESSION_ID,
    });

    const command = JSON.parse(
      await fsp.readFile(
        path.join(runDir, accepted.structuredContent.run_ref.run_id, "command.json"),
        "utf8",
      ),
    );
    expect(command.argv.slice(0, 4)).toEqual(["kimi", "-p", "review this", "--output-format"]);
    expect(command.argv).toContain("stream-json");
    expect(command.argv).toContain("-m");
    expect(command.argv).toContain("k2");
    expect(command.argv).toContain("--add-dir");
    expect(command.argv).toContain(await fsp.realpath(path.join(workspaceDir, "subdir")));
    expect(command.argv).not.toContain("--yolo");
    expect(command.argv).not.toContain("--auto");
    expect(command.argv).not.toContain("--plan");
    expect(command.output_format).toBe("stream-json");
    expect(command.env_keys).toContain("KIMI_MODEL_THINKING_EFFORT");
  });

  it("passes kimi cli_session_ref through to kimi --session", async () => {
    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "kimi-code",
        prompt: "continue",
        cwd: workspaceDir,
        cli_session_ref: {
          agent_id: "kimi-code",
          native_session_id: FAKE_KIMI_SESSION_ID,
        },
        metadata: { "kimi-code": {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("completed");
    expect(result.structuredContent.cli_session_ref.native_session_id).toBe(
      FAKE_KIMI_SESSION_ID,
    );

    const command = JSON.parse(
      await fsp.readFile(
        path.join(runDir, result.structuredContent.run_ref.run_id, "command.json"),
        "utf8",
      ),
    );
    expect(command.argv.slice(0, 2)).toEqual(["kimi", "--session"]);
    expect(command.argv).toContain(FAKE_KIMI_SESSION_ID);
  });

  it("runs an opencode agent end to end and resumes its session", async () => {
    const accepted = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "opencode",
        prompt: "review this",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: {
          opencode: {
            model: "zai-coding-plan/glm-5.3-flash",
            effort: "max",
          },
        },
      },
      { env },
    );
    expect(accepted.structuredContent.cli_session_ref).toBeNull();

    const completed = await withRunDir(runDir, () =>
      waitAgentRun({
        run_ref: accepted.structuredContent.run_ref,
        timeout_ms: 5000,
        poll_interval_ms: 50,
      }),
    );
    expect(completed.status).toBe("completed");
    expect(completed.content[0].text).toBe("fake opencode result: review this");
    expect(completed.cli_session_ref).toEqual({
      agent_id: "opencode",
      native_session_id: FAKE_OPENCODE_SESSION_ID,
    });

    const firstCommand = JSON.parse(
      await fsp.readFile(
        path.join(runDir, accepted.structuredContent.run_ref.run_id, "command.json"),
        "utf8",
      ),
    );
    expect(firstCommand.argv.slice(0, 5)).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--model",
    ]);
    expect(firstCommand.argv).toContain("zai-coding-plan/glm-5.3-flash");
    expect(firstCommand.argv).toContain("--variant");
    expect(firstCommand.argv).toContain("max");
    expect(firstCommand.argv).toContain("--auto");
    expect(firstCommand.argv).not.toContain("review this");
    expect(firstCommand.output_format).toBe("jsonl");
    expect(completed.artifacts.map((artifact) => artifact.path)).toContain("events.jsonl");

    const resumed = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "opencode",
        prompt: "continue",
        cwd: workspaceDir,
        cli_session_ref: completed.cli_session_ref,
        metadata: { opencode: {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );
    expect(resumed.structuredContent.status).toBe("completed");
    expect(resumed.structuredContent.cli_session_ref.native_session_id).toBe(
      FAKE_OPENCODE_SESSION_ID,
    );
    const resumedCommand = JSON.parse(
      await fsp.readFile(
        path.join(runDir, resumed.structuredContent.run_ref.run_id, "command.json"),
        "utf8",
      ),
    );
    expect(resumedCommand.argv).toEqual(
      expect.arrayContaining(["--session", FAKE_OPENCODE_SESSION_ID]),
    );
  });

  it("maps opencode JSON error events onto agent_error", async () => {
    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "opencode",
        prompt: "error",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { opencode: {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );
    expect(result.structuredContent.status).toBe("failed");
    expect(result.structuredContent.error).toMatchObject({
      code: "agent_error",
      message: "fake opencode failure",
    });
    expect(result.structuredContent.cli_session_ref).toEqual({
      agent_id: "opencode",
      native_session_id: FAKE_OPENCODE_SESSION_ID,
    });
  });

  it("preserves Claude structured authentication failures across runner exit", async () => {
    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "claude-code",
        prompt: "auth-error",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { claude: {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("failed");
    expect(result.structuredContent.error).toMatchObject({
      code: "agent_error",
      agent_error_code: "authentication_failed",
      message: "Failed to authenticate: OAuth session expired",
      retryable: false,
    });
    expect(result.content[0].text).toBe("Failed to authenticate: OAuth session expired");
    expect(result.structuredContent.cli_session_ref.native_session_id).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("maps kimi prompt failures onto agent_error", async () => {
    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "kimi-code",
        prompt: "error",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { "kimi-code": {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("failed");
    expect(result.structuredContent.error.code).toBe("agent_error");
    expect(result.content[0].text).toBe("fake kimi failure");
  });

  it("marks kimi-code unavailable for legacy kimi-cli version output", async () => {
    await fsp.writeFile(
      path.join(binDir, "kimi"),
      `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("kimi, version 1.49.0\\n");
  process.exit(0);
}
process.exit(1);
`,
      { mode: 0o755 },
    );

    const listed = await callAgentHubTool("list_agents", {}, { env });
    expect(listed.structuredContent.agents.map((agent) => agent.agent_id)).toEqual([
      "claude-code",
      "codex",
      "opencode",
    ]);
    const unavailable = listed.structuredContent.unavailable_agents.find(
      (agent) => agent.agent_id === "kimi-code",
    );
    expect(unavailable).toBeDefined();
    expect(unavailable.unavailable_reason).toContain("1.49.0");
  });

  it("marks kimi-code unavailable when the version is below the minimum", async () => {
    await fsp.writeFile(
      path.join(binDir, "kimi"),
      `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.9\\n");
  process.exit(0);
}
process.exit(1);
`,
      { mode: 0o755 },
    );

    const listed = await callAgentHubTool("list_agents", {}, { env });
    const unavailable = listed.structuredContent.unavailable_agents.find(
      (agent) => agent.agent_id === "kimi-code",
    );
    expect(unavailable).toBeDefined();
    expect(unavailable.unavailable_reason).toContain("below the minimum supported version");
  });

  it("marks opencode unavailable when its run command lacks the required contract", async () => {
    await fsp.writeFile(
      path.join(binDir, "opencode"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.18.25\\n");
  process.exit(0);
}
if (args[0] === "run" && args.includes("--help")) {
  process.stdout.write("--format --session --model --variant\\n");
  process.exit(0);
}
process.exit(1);
`,
      { mode: 0o755 },
    );

    const listed = await callAgentHubTool("list_agents", {}, { env });
    expect(listed.structuredContent.agents.map((agent) => agent.agent_id)).toEqual([
      "claude-code",
      "codex",
      "kimi-code",
    ]);
    const unavailable = listed.structuredContent.unavailable_agents.find(
      (agent) => agent.agent_id === "opencode",
    );
    expect(unavailable).toBeDefined();
    expect(unavailable.unavailable_reason).toContain("--auto");
  });

  it("keeps an agent available when only model discovery fails", async () => {
    await fsp.writeFile(
      path.join(binDir, "codex"),
      `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-test\\n");
  process.exit(0);
}
process.exit(2);
`,
      { mode: 0o755 },
    );

    const listed = await callAgentHubTool("list_agents", { cwd: workspaceDir }, { env });
    const codex = listed.structuredContent.agents.find(
      (agent) => agent.agent_id === "codex",
    );
    expect(codex).toBeDefined();
    expect(codex.models).toEqual([]);
    expect(codex.model_discovery).toEqual(
      expect.objectContaining({ status: "unavailable", source: "codex-debug-models" }),
    );
  });

  it("rejects a cli_session_ref whose agent_id does not match", async () => {
    const result = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "codex",
        prompt: "continue",
        cwd: workspaceDir,
        cli_session_ref: {
          agent_id: "claude-code",
          native_session_id: FAKE_CODEX_THREAD_ID,
        },
        metadata: { codex: {} },
      },
      { env },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not match agent_id/);
  });

  it("maps codex turn.failed onto a failed run with the turn error", async () => {
    const result = await callAgentHubTool(
      "run_agent",
      {
        agent_id: "codex",
        prompt: "error",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { codex: {} },
        timeout_ms: 5000,
        poll_interval_ms: 50,
      },
      { env },
    );

    expect(result.structuredContent.status).toBe("failed");
    expect(result.structuredContent.error.code).toBe("agent_error");
    expect(result.content[0].text).toBe("fake codex failure");
    expect(result.structuredContent.cli_session_ref.native_session_id).toBe(
      FAKE_CODEX_THREAD_ID,
    );
  });

  it("keeps the codex thread id when a run is cancelled mid-flight", async () => {
    const accepted = await callAgentHubTool(
      "dispatch_to_agent",
      {
        agent_id: "codex",
        prompt: "sleep",
        cwd: workspaceDir,
        cli_session_ref: null,
        metadata: { codex: {} },
      },
      { env },
    );
    const runId = accepted.structuredContent.run_ref.run_id;
    await waitForSessionRef(runDir, runId);

    const cancelled = await callAgentHubTool(
      "cancel_agent_run",
      {
        run_ref: { run_id: runId },
      },
      { env },
    );

    expect(cancelled.structuredContent.status).toBe("cancelled");
    expect(cancelled.structuredContent.cli_session_ref).toEqual({
      agent_id: "codex",
      native_session_id: FAKE_CODEX_THREAD_ID,
    });
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

async function listAgentHubTools(options = {}) {
  const stderrChunks = [];
  const env = cleanEnv(options.env ?? process.env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [defaultServerPath],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const client = new Client(
    {
      name: "agent-hub-mcp-test-client",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );
  try {
    await client.connect(transport);
    return await client.listTools(undefined, { timeout: options.requestTimeoutMs ?? 30000 });
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) {
      error.message = `${error.message}\nserver stderr:\n${stderr}`;
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function listAgentHubToolsHttp(url) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client(
    { name: "agent-hub-mcp-http-test-client", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    return await client.listTools(undefined, { timeout: 30000 });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function withAgentHubHttpServer(env, fn) {
  const port = await getFreePort();
  const stderrChunks = [];
  const child = spawn(
    process.execPath,
    [
      defaultServerPath,
      "--transport",
      "streamable-http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--path",
      "/mcp",
    ],
    {
      cwd: repoRoot,
      env: cleanEnv(env),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  try {
    await waitForTcpPort(port, child, stderrChunks);
    return await fn(`http://127.0.0.1:${port}/mcp`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2000).catch(() => child.kill("SIGKILL"));
    }
  }
}

async function runAgentHubServerExpectFailure(args, env) {
  const stderrChunks = [];
  const child = spawn(process.execPath, [defaultServerPath, ...args], {
    cwd: repoRoot,
    env: cleanEnv(env),
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const [code, signal] = await waitForClose(child, 3000);
  return {
    code,
    signal,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("could not allocate a TCP port"));
        }
      });
    });
  });
}

async function waitForTcpPort(port, child, stderrChunks) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      throw new Error(`HTTP MCP server exited early\n${stderr}`);
    }
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  throw new Error(`HTTP MCP server did not start\n${stderr}`);
}

async function canConnect(port) {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return;
  }
  await waitForClose(child, timeoutMs);
}

async function waitForClose(child, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      reject(new Error("process did not exit"));
    }, timeoutMs);
    const onClose = (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    };
    child.once("close", onClose);
  });
}

async function withRunDir(runDir, fn) {
  const previous = process.env.AGENT_HUB_RUN_DIR;
  process.env.AGENT_HUB_RUN_DIR = runDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_HUB_RUN_DIR;
    } else {
      process.env.AGENT_HUB_RUN_DIR = previous;
    }
  }
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
  let controlRequest = null;
  try {
    controlRequest = JSON.parse(input.trim());
  } catch {}
  if (
    controlRequest?.type === "control_request" &&
    controlRequest?.request?.subtype === "list_models"
  ) {
    writeJson({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: controlRequest.request_id,
        response: {
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-test",
              displayName: "Default (recommended)",
              description: "Fake default model",
              supportsEffort: true,
              supportedEffortLevels: ["low", "high"],
              supportsAdaptiveThinking: true
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-test",
              displayName: "Sonnet Test",
              description: "Fake sonnet model",
              supportsEffort: true,
              supportedEffortLevels: ["low", "high"]
            }
          ]
        }
      }
    });
    return;
  }
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
  if (input.trim() === "auth-error") {
    writeJson({
      type: "assistant",
      error: "authentication_failed",
      message: {
        content: [
          {
            type: "text",
            text: "Failed to authenticate: OAuth session expired"
          }
        ]
      },
      session_id: sessionId
    });
    writeResult("Failed to authenticate: OAuth session expired", true);
    process.exitCode = 1;
    return;
  }
  if (input.includes("AGENT_HUB_DISCUSSION_PROTOCOL_V1")) {
    const marker = "[OUTPUT CONTRACT]\\n";
    const markerIndex = input.lastIndexOf(marker);
    const output = markerIndex >= 0
      ? input.slice(markerIndex + marker.length).trim()
      : JSON.stringify({ schema_version: 1 });
    writeAssistant(output);
    writeResult(output);
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

async function writeFakeCodex(target) {
  await fsp.writeFile(
    target,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-test\\n");
  process.exit(0);
}
if (args[0] === "debug" && args[1] === "models") {
  process.stdout.write(JSON.stringify({
    models: [
      {
        slug: "gpt-test-codex",
        display_name: "GPT Test Codex",
        description: "Fake Codex model",
        visibility: "list",
        priority: 1,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
        context_window: 128000,
        input_modalities: ["text", "image"],
        supports_reasoning_summaries: true
      },
      {
        slug: "gpt-hidden",
        display_name: "Hidden",
        visibility: "hidden",
        priority: 0
      }
    ]
  }));
  process.exit(0);
}
const resumeIndex = args.indexOf("resume");
const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : "${FAKE_CODEX_THREAD_ID}";
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const writeEvent = (value) => {
    process.stdout.write(JSON.stringify(value) + "\\n");
  };
  writeEvent({ type: "thread.started", thread_id: threadId });
  writeEvent({ type: "turn.started" });
  const prompt = input.trim();
  if (prompt === "sleep") {
    setTimeout(() => {
      writeEvent({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "late codex result" }
      });
      writeEvent({ type: "turn.completed", usage: {} });
    }, 30000);
    return;
  }
  if (prompt === "error") {
    writeEvent({ type: "error", message: "fake codex failure" });
    writeEvent({ type: "turn.failed", error: { message: "fake codex failure" } });
    process.exitCode = 1;
    return;
  }
  writeEvent({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "fake codex result: " + prompt }
  });
  writeEvent({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
});
`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

async function writeFakeKimi(target) {
  await fsp.writeFile(
    target,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("0.26.0-test\\n");
  process.exit(0);
}
if (args[0] === "provider" && args[1] === "list" && args.includes("--json")) {
  process.stdout.write(JSON.stringify({
    models: {
      "kimi-code/test": {
        displayName: "Kimi Test",
        model: "test",
        maxContextSize: 131072,
        capabilities: ["thinking", "image_in", "tool_use"],
        defaultEffort: "high",
        supportEfforts: ["low", "high"]
      }
    },
    providers: {
      "managed:test": {
        type: "kimi",
        apiKey: "secret-provider-key"
      }
    }
  }));
  process.exit(0);
}
const sessionIndex = args.indexOf("--session");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "${FAKE_KIMI_SESSION_ID}";
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const writeEvent = (value) => {
    process.stdout.write(JSON.stringify(value) + "\\n");
  };
  const writeResumeHint = () => {
    writeEvent({
      role: "meta",
      type: "session.resume_hint",
      session_id: sessionId,
      command: "kimi -r " + sessionId,
      content: "To resume this session: kimi -r " + sessionId
    });
  };
  if (prompt === "sleep") {
    setTimeout(() => {
      writeEvent({ role: "assistant", content: "late kimi result" });
      writeResumeHint();
    }, 30000);
    return;
  }
  if (prompt === "error") {
    process.stderr.write("error: failed to run prompt: fake kimi failure\\n");
    process.exit(1);
  }
  writeEvent({ role: "assistant", content: "fake kimi result: " + prompt });
  writeResumeHint();
});
`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

async function writeFakeOpenCode(target) {
  await fsp.writeFile(
    target,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.18.25\\n");
  process.exit(0);
}
if (args[0] === "run" && args.includes("--help")) {
  process.stdout.write("--format --session --model --variant --auto\\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("zai-coding-plan/glm-5.3-flash\\n");
  process.exit(0);
}
if (args[0] !== "run") process.exit(2);
const sessionIndex = args.indexOf("--session");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "${FAKE_OPENCODE_SESSION_ID}";
const promptSeparator = args.indexOf("--");
const argvPrompt = promptSeparator >= 0
  ? args.slice(promptSeparator + 1)
      .map((arg) => arg.includes(" ") ? '"' + arg.replace(/"/g, '\\\\"') + '"' : arg)
      .join(" ")
  : "";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const prompt = argvPrompt && input ? argvPrompt + "\\n" + input : argvPrompt || input;
  const writeEvent = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  writeEvent({ type: "step_start", sessionID: sessionId, part: { type: "step-start" } });
  if (prompt === "sleep") {
    setTimeout(() => {
      writeEvent({ type: "text", sessionID: sessionId, part: { type: "text", text: "late opencode result" } });
    }, 30000);
    return;
  }
  if (prompt === "error") {
    writeEvent({
      type: "error",
      sessionID: sessionId,
      error: { name: "ProviderError", data: { message: "fake opencode failure" } }
    });
    process.exitCode = 1;
    return;
  }
  writeEvent({
    type: "text",
    sessionID: sessionId,
    part: { type: "text", text: "fake opencode result: " + prompt }
  });
  writeEvent({ type: "step_finish", sessionID: sessionId, part: { type: "step-finish" } });
});
`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

async function waitForSessionRef(root, runId) {
  const statePath = path.join(root, runId, "state.json");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const text = await fsp.readFile(statePath, "utf8").catch(() => "{}");
    const state = JSON.parse(text);
    if (state.cli_session_ref?.native_session_id) {
      return state.cli_session_ref;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("run did not record a cli_session_ref");
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

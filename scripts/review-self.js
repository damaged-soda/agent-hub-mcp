#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callAgentHubTool } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const prompt = `Review this repository's current implementation against docs/architecture.md.

Focus on whether the Agent Hub MCP flow can call Claude Code CLI end to end via MCP tools:
- list_agents
- dispatch_to_agent
- query_agent_run
- wait_agent_run
- cancel_agent_run
- run_agent for short tasks only

Prioritize correctness, process lifecycle, result semantics, security defaults, and test coverage.
Use a code-review format with findings first. For every finding include severity and file:line.
Classify severity as critical, high, medium, low, or note.

At the end, include exactly one of these lines:
HIGH_OR_CRITICAL_FINDINGS: yes
HIGH_OR_CRITICAL_FINDINGS: no`;

const accepted = await callAgentHubTool(
  "dispatch_to_agent",
  {
    agent_id: "claude-code",
    prompt,
    cwd: repoRoot,
    cli_session_ref: null,
    metadata: {
      claude: {
        model: "sonnet",
        effort: "medium",
      },
    },
  },
);

const deadline = Date.now() + 900000;
const terminalStatuses = new Set(["completed", "failed", "cancelled", "unknown"]);
let result = accepted;
while (!terminalStatuses.has(result.structuredContent?.status)) {
  if (Date.now() >= deadline) {
    throw new Error(
      `Review did not finish before deadline: ${accepted.structuredContent.run_ref.run_id}`,
    );
  }
  result = await callAgentHubTool(
    "wait_agent_run",
    {
      run_ref: accepted.structuredContent.run_ref,
      timeout_ms: 30000,
      poll_interval_ms: 1000,
    },
    {
      requestTimeoutMs: 60000,
    },
  );
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

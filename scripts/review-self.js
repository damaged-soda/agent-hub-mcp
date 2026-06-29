#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callAgentHubTool } from "./mcp-client.js";
import {
  POLL_AFTER_MS,
  WAIT_AGENT_RUN_REQUEST_TIMEOUT_MS,
} from "../src/timing.js";

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

const REVIEW_DEADLINE_MS = 900000;
const QUERY_REQUEST_TIMEOUT_MS = 5000;
const WAIT_DEADLINE_MARGIN_MS = 5000;

const deadline = Date.now() + REVIEW_DEADLINE_MS;
const terminalStatuses = new Set(["completed", "failed", "cancelled", "unknown"]);
let result = accepted;
while (!terminalStatuses.has(result.structuredContent?.status)) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(
      `Review did not finish before deadline: ${accepted.structuredContent.run_ref.run_id}`,
    );
  }
  if (remainingMs >= WAIT_AGENT_RUN_REQUEST_TIMEOUT_MS + WAIT_DEADLINE_MARGIN_MS) {
    result = await callAgentHubTool(
      "wait_agent_run",
      {
        run_ref: accepted.structuredContent.run_ref,
      },
    );
  } else {
    const sleepMs = Math.min(
      POLL_AFTER_MS,
      Math.max(0, remainingMs - QUERY_REQUEST_TIMEOUT_MS),
    );
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
    const queryRemainingMs = deadline - Date.now();
    if (queryRemainingMs <= 0) {
      throw new Error(
        `Review did not finish before deadline: ${accepted.structuredContent.run_ref.run_id}`,
      );
    }
    result = await callAgentHubTool(
      "query_agent_run",
      {
        run_ref: accepted.structuredContent.run_ref,
      },
      {
        requestTimeoutMs: Math.max(1, Math.min(QUERY_REQUEST_TIMEOUT_MS, queryRemainingMs)),
      },
    );
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

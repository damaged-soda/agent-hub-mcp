#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchToAgent, queryAgentRun, waitAgentRun } from "../src/runs.js";
import { POLL_AFTER_MS } from "../src/timing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const prompt = `Review this repository's current implementation against docs/architecture.md.

Focus on whether the daemon-free agenthub CLI and detached workers can call Claude Code end to end,
persist state across separate CLI processes, recover Discussions, and preserve the optional MCP surface.

Prioritize correctness, process lifecycle, result semantics, security defaults, and test coverage.
Use a code-review format with findings first. For every finding include severity and file:line.
Classify severity as critical, high, medium, low, or note.

At the end, include exactly one of these lines:
HIGH_OR_CRITICAL_FINDINGS: yes
HIGH_OR_CRITICAL_FINDINGS: no`;

const accepted = await dispatchToAgent({
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
});

const REVIEW_DEADLINE_MS = 900000;
const deadline = Date.now() + REVIEW_DEADLINE_MS;
const terminalStatuses = new Set(["completed", "failed", "cancelled", "unknown"]);
let result = accepted;
while (!terminalStatuses.has(result.status)) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`Review did not finish before deadline: ${accepted.run_ref.run_id}`);
  }
  result = await waitAgentRun({
    run_ref: accepted.run_ref,
    timeout_ms: Math.min(remainingMs, 600000),
  });
  if (result.timed_out) {
    await sleep(Math.min(POLL_AFTER_MS, Math.max(1, deadline - Date.now())));
    result = await queryAgentRun({ run_ref: accepted.run_ref });
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

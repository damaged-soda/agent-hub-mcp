#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import {
  cancelAgentRun,
  dispatchToAgent,
  listAgents,
  queryAgentRun,
  runAgent,
  waitAgentRun,
} from "./runs.js";

const server = new McpServer({
  name: "agent-hub-mcp",
  version: "0.1.0",
}, {
  instructions: [
    "Agent Hub runs local agent CLIs as background jobs.",
    "For agentic or long-running work, call dispatch_to_agent first, keep the run_ref, then poll with query_agent_run or short wait_agent_run calls.",
    "A wait_agent_run response with timed_out: true means the run is still active; continue polling instead of treating it as failure.",
    "Only call cancel_agent_run when the user explicitly asks to stop the run or the run is clearly no longer needed.",
    "Use run_agent only for short tasks that should finish inside the MCP client's tool timeout.",
  ].join(" "),
});

const CliSessionRefSchema = z
  .object({
    agent_id: z.string(),
    native_session_id: z.string(),
  })
  .nullable()
  .optional();

const RunRefSchema = z.object({
  run_id: z.string(),
});

const DispatchInputSchema = {
  agent_id: z.string(),
  prompt: z.string(),
  cwd: z.string(),
  cli_session_ref: CliSessionRefSchema,
  metadata: z.record(z.any()).optional(),
};

const WaitInputSchema = {
  run_ref: RunRefSchema,
  timeout_ms: z.number().finite().int().positive().max(3600000).optional(),
  poll_interval_ms: z.number().finite().int().positive().optional(),
};

const CancelInputSchema = {
  run_ref: RunRefSchema,
  reason: z.string().optional(),
  actor: z.string().optional(),
};

server.registerTool(
  "list_agents",
  {
    title: "List Agents",
    description: "List locally available agent CLI adapters.",
    inputSchema: {},
  },
  async () => asToolResult(await listAgents()),
);

server.registerTool(
  "dispatch_to_agent",
  {
    title: "Dispatch To Agent",
    description:
      "Start a non-interactive agent CLI run and return immediately. Prefer this for long-running or agentic work.",
    inputSchema: DispatchInputSchema,
  },
  async (input) => asToolResult(await dispatchToAgent(input)),
);

server.registerTool(
  "query_agent_run",
  {
    title: "Query Agent Run",
    description: "Read the latest state snapshot for a run.",
    inputSchema: {
      run_ref: RunRefSchema,
    },
  },
  async (input) => asToolResult(await queryAgentRun(input)),
);

server.registerTool(
  "wait_agent_run",
  {
    title: "Wait Agent Run",
    description:
      "Wait briefly for a run. If timed_out is true, keep the run_ref and poll again instead of cancelling.",
    inputSchema: WaitInputSchema,
  },
  async (input) => asToolResult(await waitAgentRun(input)),
);

server.registerTool(
  "cancel_agent_run",
  {
    title: "Cancel Agent Run",
    description: "Cancel a local run created by Agent Hub.",
    inputSchema: CancelInputSchema,
  },
  async (input) => asToolResult(await cancelAgentRun(input)),
);

server.registerTool(
  "run_agent",
  {
    title: "Run Agent",
    description:
      "Dispatch a run and wait for a short result window. Use dispatch_to_agent plus polling for long-running work.",
    inputSchema: {
      ...DispatchInputSchema,
      timeout_ms: z.number().finite().int().positive().max(3600000).optional(),
      poll_interval_ms: z.number().finite().int().positive().optional(),
    },
  },
  async (input) => asToolResult(await runAgent(input)),
);

function asToolResult(value) {
  if (Array.isArray(value?.content) && value.content.length > 0) {
    return {
      content: value.content,
      structuredContent: value,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("agent-hub-mcp listening on stdio");
}

main().catch((error) => {
  console.error("agent-hub-mcp server error:", error);
  process.exit(1);
});

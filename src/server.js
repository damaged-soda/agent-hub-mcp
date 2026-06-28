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
    description: "Start a non-interactive agent CLI run and return immediately.",
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
    description: "Block until a run reaches a terminal state or the timeout expires.",
    inputSchema: WaitInputSchema,
  },
  async (input) => asToolResult(await waitAgentRun(input)),
);

server.registerTool(
  "cancel_agent_run",
  {
    title: "Cancel Agent Run",
    description: "Cancel a local run created by Agent Hub.",
    inputSchema: {
      run_ref: RunRefSchema,
    },
  },
  async (input) => asToolResult(await cancelAgentRun(input)),
);

server.registerTool(
  "run_agent",
  {
    title: "Run Agent",
    description: "Dispatch a run and wait for the result.",
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

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import * as z from "zod";
import {
  cancelAgentRun,
  dispatchToAgent,
  listAgents,
  queryAgentRun,
  runAgent,
  waitAgentRun,
} from "./runs.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const HTTP_SHUTDOWN_GRACE_MS = 30000;

function createAgentHubServer() {
  const server = new McpServer(
    {
      name: "agent-hub-mcp",
      version: "0.1.0",
    },
    {
      instructions: [
        "Agent Hub runs local agent CLIs as background jobs.",
        "For agentic or long-running work, call dispatch_to_agent first, keep the run_ref, then call wait_agent_run.",
        "If a wait_agent_run response has timed_out: true, or if the MCP client tool call times out first, keep the run_ref and call query_agent_run or wait_agent_run again instead of treating it as failure.",
        "Only call cancel_agent_run when the user explicitly asks to stop the run or the run is clearly no longer needed.",
        "Use run_agent only for short tasks that should finish inside the MCP client's tool timeout.",
      ].join(" "),
    },
  );

  registerTools(server);
  return server;
}

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
};

const CancelInputSchema = {
  run_ref: RunRefSchema,
  reason: z.string().optional(),
  actor: z.string().optional(),
};

function registerTools(server) {
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
        "Wait for a run using the server's wait window. If timed_out is true, keep the run_ref and call query_agent_run or wait_agent_run again instead of cancelling.",
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
}

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
  const options = parseArgs(process.argv.slice(2));
  if (options.transport === "stdio") {
    const server = createAgentHubServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("agent-hub-mcp listening on stdio");
    return;
  }

  await listenStreamableHttp(options);
}

function parseArgs(argv) {
  const options = {
    transport: "stdio",
    host: "127.0.0.1",
    port: 8700,
    path: "/mcp",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--transport") {
      options.transport = requireValue(arg, argv[++i]);
    } else if (arg === "--host") {
      options.host = requireValue(arg, argv[++i]);
    } else if (arg === "--port") {
      options.port = Number.parseInt(requireValue(arg, argv[++i]), 10);
    } else if (arg === "--path") {
      options.path = requireValue(arg, argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["stdio", "streamable-http"].includes(options.transport)) {
    throw new Error("--transport must be stdio or streamable-http");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (!options.path.startsWith("/")) {
    throw new Error("--path must start with /");
  }
  if (!LOOPBACK_HOSTS.has(options.host)) {
    throw new Error("--host must be a loopback host: 127.0.0.1, ::1, or localhost");
  }

  return options;
}

function requireValue(flag, value) {
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function listenStreamableHttp(options) {
  const activeRequests = new Set();
  const httpServer = createHttpServer(async (req, res) => {
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (requestPath !== options.path) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonRpcError(-32004, "Not found")));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonRpcError(-32000, "Method not allowed.")));
      return;
    }

    const server = createAgentHubServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const activeRequest = { server, transport };
    activeRequests.add(activeRequest);
    res.on("close", () => {
      activeRequests.delete(activeRequest);
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("agent-hub-mcp HTTP request error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify(jsonRpcError(-32603, "Internal server error")));
      }
    } finally {
      if (res.writableEnded) {
        activeRequests.delete(activeRequest);
      }
    }
  });

  await new Promise((resolve) => {
    httpServer.listen(options.port, options.host, resolve);
  });
  installHttpShutdownHandlers(httpServer, activeRequests);
  console.error(
    `agent-hub-mcp listening on http://${options.host}:${options.port}${options.path}`,
  );
}

function installHttpShutdownHandlers(httpServer, activeRequests) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`agent-hub-mcp received ${signal}, shutting down HTTP server`);
    httpServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      for (const { server, transport } of activeRequests) {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      }
      process.exit(0);
    }, HTTP_SHUTDOWN_GRACE_MS).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function jsonRpcError(code, message) {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  };
}

main().catch((error) => {
  console.error("agent-hub-mcp server error:", error);
  process.exit(1);
});

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

function createAgentHubServer(options = {}) {
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

  registerTools(server, options);
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

const DiscussionRefSchema = z.object({ discussion_id: z.string() }).strict();

const DiscussionMaterialSchema = z.discriminatedUnion("type", [
  z
    .object({
      material_id: z.string(),
      type: z.literal("inline"),
      title: z.string(),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      material_id: z.string(),
      type: z.literal("file"),
      title: z.string(),
      path: z.string(),
    })
    .strict(),
]);

const DiscussionHostSchema = z
  .object({
    agent_id: z.string(),
    metadata: z.record(z.any()).optional(),
  })
  .strict();

const DiscussionParticipantSchema = z
  .object({
    participant_id: z.string(),
    agent_id: z.string(),
    role: z.string(),
    focus: z.string(),
    metadata: z.record(z.any()).optional(),
  })
  .strict();

const DiscussionDispatchInputSchema = z.union([
  z
    .object({
      kind: z.literal("new"),
      objective: z.string(),
      question: z.string(),
      cwd: z.string(),
      materials: z.array(DiscussionMaterialSchema).optional(),
      host: DiscussionHostSchema,
      participants: z.array(DiscussionParticipantSchema).min(2),
      quorum: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("follow_up"),
      parent_discussion_ref: DiscussionRefSchema,
      question: z.string(),
      materials: z.array(DiscussionMaterialSchema).optional(),
    })
    .strict(),
]);

const DiscussionQueryInputSchema = z
  .object({
    discussion_ref: DiscussionRefSchema,
    after_sequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

function registerTools(server, options = {}) {
  server.registerTool(
    "list_agents",
    {
      title: "List Agents",
      description:
        "List locally available agent CLI adapters and their selectable models. Pass cwd to resolve workspace-specific CLI configuration.",
      inputSchema: {
        cwd: z.string().optional(),
      },
    },
    async (input) => asToolResult(await listAgents(input)),
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

  if (options.discussionManager) {
    registerDiscussionTools(server, options.discussionManager);
  }
}

function registerDiscussionTools(server, manager) {
  server.registerTool(
    "dispatch_discussion",
    {
      title: "Dispatch Discussion",
      description:
        "Start a fixed-protocol multi-agent discussion. Participants are selected by the caller during preparation. Runs use adapter-configured best-effort read-only behavior; this is not a security boundary.",
      inputSchema: DiscussionDispatchInputSchema,
    },
    async (input) => asToolResult(await manager.dispatch(input)),
  );

  server.registerTool(
    "query_discussion",
    {
      title: "Query Discussion",
      description: "Read the latest discussion projection, active runs, artifacts, and paged events.",
      inputSchema: DiscussionQueryInputSchema,
    },
    async (input) => asToolResult(await manager.query(input)),
  );

  server.registerTool(
    "wait_discussion",
    {
      title: "Wait Discussion",
      description:
        "Wait for a discussion terminal state. A timed_out response means the same discussion_ref should be waited again; it does not cancel the discussion.",
      inputSchema: DiscussionQueryInputSchema,
    },
    async (input) => asToolResult(await manager.wait(input)),
  );

  server.registerTool(
    "cancel_discussion",
    {
      title: "Cancel Discussion",
      description: "Persist cancellation intent and cancel all currently known active discussion runs.",
      inputSchema: z
        .object({
          discussion_ref: DiscussionRefSchema,
          reason: z.string().optional(),
          actor: z.string().optional(),
        })
        .strict(),
    },
    async (input) => asToolResult(await manager.cancel(input)),
  );
}

function asToolResult(value) {
  if (Array.isArray(value?.content) && value.content.length > 0) {
    return {
      content: value.content,
      structuredContent: value,
    };
  }
  if (typeof value?.content === "string" && value.content) {
    return {
      content: [{ type: "text", text: value.content }],
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
    console.error("agent-hub-mcp listening on stdio (deprecated; discussion tools are HTTP-only)");
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
  const { DiscussionManager } = await import("./discussion-manager.js");
  const discussionManager = new DiscussionManager();
  await discussionManager.start();
  const activeRequests = new Set();
  const httpServer = createHttpServer(async (req, res) => {
    if (!isAllowedHttpOrigin(req.headers.origin)) {
      res.writeHead(403, {
        "content-type": "application/json",
        vary: "Origin",
      });
      res.end(JSON.stringify(jsonRpcError(-32003, "Forbidden origin")));
      return;
    }
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

    const server = createAgentHubServer({ discussionManager });
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
  installHttpShutdownHandlers(httpServer, activeRequests, discussionManager);
  console.error(
    `agent-hub-mcp listening on http://${options.host}:${options.port}${options.path}`,
  );
}

function isAllowedHttpOrigin(origin) {
  if (!origin) {
    return true;
  }
  const allowed = new Set(
    (process.env.AGENT_HUB_HTTP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return allowed.has(origin);
}

function installHttpShutdownHandlers(httpServer, activeRequests, discussionManager) {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`agent-hub-mcp received ${signal}, shutting down HTTP server`);
    const forcedExit = setTimeout(() => {
      for (const { server, transport } of activeRequests) {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      }
      process.exit(0);
    }, HTTP_SHUTDOWN_GRACE_MS).unref();
    const closed = new Promise((resolve) => httpServer.close(resolve));
    await discussionManager.shutdown().catch((error) => {
      console.error("agent-hub-mcp discussion shutdown error:", error);
    });
    for (const { server, transport } of activeRequests) {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    await closed;
    clearTimeout(forcedExit);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
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

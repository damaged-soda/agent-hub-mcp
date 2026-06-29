#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultServerPath = path.join(repoRoot, "src", "server.js");

export async function callAgentHubTool(name, args, options = {}) {
  const stderrChunks = [];
  const env = cleanEnv(options.env ?? process.env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverPath ?? defaultServerPath],
    cwd: options.cwd ?? repoRoot,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const client = new Client(
    {
      name: "agent-hub-mcp-cli-client",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport);
    return await client.callTool(
      {
        name,
        arguments: args,
      },
      undefined,
      {
        timeout: options.requestTimeoutMs ?? defaultRequestTimeoutMs(args),
      },
    );
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

async function main() {
  const { toolName, args, requestTimeoutMs } = await parseCli(process.argv.slice(2));
  const result = await callAgentHubTool(toolName, args, { requestTimeoutMs });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function parseCli(argv) {
  const toolName = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "list_agents";
  let args = {};
  let requestTimeoutMs;
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--json") {
      args = JSON.parse(expectValue(flag, argv.shift()));
    } else if (flag === "--json-file") {
      args = JSON.parse(await fsp.readFile(expectValue(flag, argv.shift()), "utf8"));
    } else if (flag === "--request-timeout-ms") {
      requestTimeoutMs = Number(expectValue(flag, argv.shift()));
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return { toolName, args, requestTimeoutMs };
}

function expectValue(flag, value) {
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string"),
  );
}

function defaultRequestTimeoutMs(args) {
  const agentTimeout = Number.isFinite(args?.timeout_ms) ? args.timeout_ms : 30000;
  return agentTimeout + 30000;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}

#!/usr/bin/env node

import {
  discoverNativeSessions,
  inspectNativeSession,
  resolveNativeSessionReference,
} from "./agent-session-sources.js";
import {
  normalizeBasePath,
  normalizePublicOrigin,
  startSessionServer,
} from "./session-server.js";

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (command === "resolve") {
    if (rest.length !== 1) throw new Error("resolve requires exactly one session reference");
    printJson(await resolveNativeSessionReference(rest[0]));
    return;
  }
  const flags = parseFlags(rest);
  if (command === "list") {
    rejectUnknown(flags, new Set(["provider", "query", "limit"]));
    const data = await discoverNativeSessions({
      provider: flags.provider,
      query: flags.query,
      limit: flags.limit,
    });
    printJson({
      api_version: 1,
      kind: "agent-session-list",
      total_discovered: data.total_discovered,
      matched: data.matched,
      ...(data.query === null ? {} : { query: data.query }),
      data,
      ...(data.source_errors?.length > 0 ? { source_errors: data.source_errors } : {}),
    });
    return;
  }
  if (command === "inspect") {
    rejectUnknown(
      flags,
      new Set(["provider", "session-id", "profile", "after", "limit"]),
    );
    if (!flags.provider || !flags["session-id"]) {
      throw new Error("inspect requires --provider and --session-id");
    }
    printJson(
      await inspectNativeSession({
        provider: flags.provider,
        native_session_id: flags["session-id"],
        profile: flags.profile,
        after: flags.after,
        limit: flags.limit,
      }),
    );
    return;
  }
  if (command === "serve") {
    rejectUnknown(
      flags,
      new Set(["host", "port", "public-origin", "base-path"]),
    );
    const publicOrigin = normalizePublicOrigin(flags["public-origin"]);
    const basePath = normalizeBasePath(flags["base-path"]);
    const server = await startSessionServer({
      host: flags.host,
      port: flags.port,
      publicOrigin,
      basePath,
    });
    const address = server.address();
    const host = typeof address === "object" && address ? address.address : flags.host || "127.0.0.1";
    const port = typeof address === "object" && address ? address.port : flags.port || 8765;
    printJson({
      api_version: 1,
      kind: "agent-session-server",
      url: `http://${host.includes(":") ? `[${host}]` : host}:${port}${
        basePath ? `${basePath}/` : "/"
      }`,
      public_origin: publicOrigin || undefined,
      base_path: basePath || undefined,
    });
    const close = () => server.close(() => process.exit(0));
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  throw new Error(`Unknown agent-session command: ${command}`);
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--") || token.length === 2) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    if (Object.hasOwn(flags, key)) throw new Error(`Duplicate flag: --${key}`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

function rejectUnknown(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new Error(`Unknown flag: --${key}`);
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function helpText() {
  return `agent-session — inspect provider-native agent sessions without mutating them

Usage:
  agent-session list [--provider claude|codex|kimi|opencode] [--query TEXT] [--limit N]
  agent-session inspect --provider ID --session-id ID
      [--profile metadata|inspect] [--after N] [--limit N]
  agent-session resolve 'agenthub://session/v1/PROVIDER/SESSION_ID[/event/EVENT_ID]'
  agent-session serve [--host 127.0.0.1] [--port 8765]
      [--public-origin https://cockpit.example.ts.net] [--base-path /agent-session]

HTTP endpoints: GET /, GET /healthz, GET /api/sessions,
and GET /api/sessions/PROVIDER/SESSION_ID (all below --base-path when set).

List --query matches one case-insensitive substring against every discovered session's
title, cwd, native session id, provider, and source kind before --limit truncates the
result; total_discovered and matched report the full directory size and the full match
count. The default inspect profile is metadata. Resolve identifies one copied session reference;
event references additionally return a bounded inspect diagnostic. Use --profile inspect
to include visible prompts, assistant text, tool arguments, and tool results when paging
a session. Thinking blocks are never projected. Commands only read provider-native files;
they do not clean up stores, repair state, probe models, launch agents, or create a session
database.
`;
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ error: { code: "agent_session_error", message: error.message } })}\n`,
  );
  process.exitCode = 1;
});

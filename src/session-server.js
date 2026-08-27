import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverNativeSessions, inspectNativeSession } from "./agent-session-sources.js";

const assetRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "ui",
  "session-inspector",
);
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1"]);
const LOOPBACK_REQUEST_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export async function startSessionServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_BIND_HOSTS.has(host)) {
    throw new Error("agent-session serve host must be the literal 127.0.0.1 or ::1");
  }
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const serverOptions = { ...options, publicOrigin };
  const port = boundedPort(options.port ?? 8765);
  const server = http.createServer((request, response) => {
    handleRequest(request, response, serverOptions).catch((error) => {
      sendJson(response, statusForError(error), {
        error: { code: "agent_session_server_error", message: error.message },
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleRequest(request, response, options) {
  setSecurityHeaders(response);
  if (!requestHostAllowed(request.headers.host, options.publicOrigin)) {
    sendJson(response, 403, { error: { code: "host_forbidden", message: "Loopback Host required" } });
    return;
  }
  const origin = request.headers.origin;
  if (!requestOriginAllowed(origin, request.headers.host, options.publicOrigin)) {
    sendJson(response, 403, { error: { code: "origin_forbidden", message: "Same origin required" } });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "GET only" } });
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/api/sessions") {
    const data = await discoverNativeSessions({
      provider: optionalQuery(url, "provider"),
      limit: optionalQuery(url, "limit") ?? 50,
      roots: options.roots,
      env: options.env,
    });
    sendJson(response, 200, { api_version: 1, kind: "agent-session-list", data }, request.method);
    return;
  }
  const match = /^\/api\/sessions\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const document = await inspectNativeSession(
      {
        provider: decodeURIComponent(match[1]),
        native_session_id: decodeURIComponent(match[2]),
        profile: optionalQuery(url, "profile") ?? "metadata",
        after: optionalQuery(url, "after") ?? 0,
        limit: optionalQuery(url, "limit") ?? 200,
      },
      { roots: options.roots, env: options.env },
    );
    sendJson(response, 200, document, request.method);
    return;
  }
  const asset = ASSETS.get(url.pathname);
  if (asset) {
    const [fileName, contentType] = asset;
    const body = await fsp.readFile(path.join(assetRoot, fileName));
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
    return;
  }
  sendJson(response, 404, { error: { code: "not_found", message: "Not found" } }, request.method);
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response, status, document, method = "GET") {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = Buffer.from(`${JSON.stringify(document)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  if (method === "HEAD") response.end();
  else response.end(body);
}

function optionalQuery(url, key) {
  const value = url.searchParams.get(key);
  return value === null || value === "" ? undefined : value;
}

function boundedPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  return port;
}

function requestHostAllowed(value, publicOrigin) {
  if (typeof value !== "string" || !value) return false;
  try {
    const requestUrl = new URL(`http://${value}`);
    const hostname = requestUrl.hostname.replace(/^\[|\]$/g, "");
    if (LOOPBACK_REQUEST_HOSTS.has(hostname)) return true;
    return Boolean(publicOrigin && requestUrl.host === new URL(publicOrigin).host);
  } catch {
    return false;
  }
}

function requestOriginAllowed(origin, host, publicOrigin) {
  if (!origin) return true;
  if (requestHostIsLoopback(host)) return origin === `http://${host}`;
  return Boolean(publicOrigin && origin === publicOrigin);
}

function requestHostIsLoopback(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "");
    return LOOPBACK_REQUEST_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export function normalizePublicOrigin(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("public origin must be a string");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("public origin must be an absolute HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("public origin must be an absolute HTTPS origin without path or credentials");
  }
  return parsed.origin;
}

function statusForError(error) {
  const message = String(error?.message ?? "");
  if (/^Unknown .*native_session_id/.test(message)) return 404;
  if (/must be|Unsupported|requires|Unknown flag|Unexpected/.test(message)) return 400;
  return 500;
}

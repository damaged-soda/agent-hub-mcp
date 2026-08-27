import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSessionServer } from "../src/session-server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "agent-session");
const CODEX_ID = "01a03dc9-2a7e-76a2-b03d-39e06e22a5b6";

function requestStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
  });
}

let tempRoot;
let roots;
let server;
let baseUrl;

beforeAll(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-session-server-"));
  roots = {
    claude: path.join(tempRoot, "claude"),
    codex: path.join(tempRoot, "codex"),
    kimi: path.join(tempRoot, "kimi"),
  };
  const codexPath = path.join(
    roots.codex,
    "sessions",
    "2026",
    "08",
    "26",
    `rollout-2026-08-26T10-00-00-${CODEX_ID}.jsonl`,
  );
  await fsp.mkdir(path.dirname(codexPath), { recursive: true });
  await fsp.copyFile(path.join(fixtureRoot, "codex-transcript.jsonl"), codexPath);
  await fsp.writeFile(
    path.join(roots.codex, "session_index.jsonl"),
    `${JSON.stringify({ id: CODEX_ID, thread_name: "审查 Agent Session 改动" })}\n`,
  );
  server = await startSessionServer({ host: "127.0.0.1", port: 0, roots });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe("agent session server", () => {
  it("serves a versioned no-store API discovery document without UI assets", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.json()).toEqual({
      api_version: 1,
      kind: "agent-session-service",
      data: {
        read_only: true,
        profiles: ["metadata", "inspect"],
        endpoints: {
          health: "healthz",
          sessions: "api/sessions",
          inspect: "api/sessions/{provider}/{native_session_id}",
        },
      },
    });
    const health = await fetch(`${baseUrl}/healthz`);
    expect(await health.json()).toEqual({
      api_version: 1,
      kind: "agent-session-health",
      status: "ok",
    });
    expect((await fetch(`${baseUrl}/index.html`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/app.js`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/style.css`)).status).toBe(404);
  });

  it("keeps API bodies hidden until inspect is explicit", async () => {
    const list = await fetch(`${baseUrl}/api/sessions?limit=10`);
    expect(list.status).toBe(200);
    expect((await list.json()).data[0]).toMatchObject({
      native_session_id: CODEX_ID,
      session_ref: `agenthub://session/v1/codex/${CODEX_ID}`,
      title: "审查 Agent Session 改动",
    });

    const metadata = await fetch(
      `${baseUrl}/api/sessions/codex/${CODEX_ID}?profile=metadata&limit=100`,
    );
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(await metadata.text()).not.toContain("Private developer prompt");

    const inspect = await fetch(
      `${baseUrl}/api/sessions/codex/${CODEX_ID}?profile=inspect&limit=100`,
    );
    const inspectDocument = await inspect.json();
    expect(JSON.stringify(inspectDocument)).toContain("Private developer prompt");
    expect(inspectDocument.data.every((event) => event.event_ref?.startsWith(
      `agenthub://session/v1/codex/${CODEX_ID}/event/e1_`,
    ))).toBe(true);
  });

  it("returns conflict instead of choosing between divergent sources for one session", async () => {
    const archivedDir = path.join(roots.codex, "archived_sessions");
    const archivedPath = path.join(archivedDir, `rollout-copy-${CODEX_ID}.jsonl`);
    const source = await fsp.readFile(path.join(
      roots.codex,
      "sessions",
      "2026",
      "08",
      "26",
      `rollout-2026-08-26T10-00-00-${CODEX_ID}.jsonl`,
    ), "utf8");
    await fsp.mkdir(archivedDir, { recursive: true });
    await fsp.writeFile(archivedPath, source.replace("/workspace/example", "/workspace/conflict"));
    try {
      const response = await fetch(
        `${baseUrl}/api/sessions/codex/${CODEX_ID}?profile=inspect&limit=100`,
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error.message).toMatch(/Ambiguous.*conflicting/);
    } finally {
      await fsp.rm(archivedDir, { recursive: true, force: true });
    }
  });

  it("rejects mutating methods, foreign origins, and non-loopback binds", async () => {
    expect((await fetch(`${baseUrl}/api/sessions`, { method: "POST" })).status).toBe(405);
    expect(
      (
        await fetch(`${baseUrl}/api/sessions`, {
          headers: { Origin: "https://attacker.invalid" },
        })
      ).status,
    ).toBe(403);
    await expect(startSessionServer({ host: "0.0.0.0", port: 0, roots })).rejects.toThrow(
      /literal 127\.0\.0\.1 or ::1/,
    );
    await expect(startSessionServer({ host: "localhost", port: 0, roots })).rejects.toThrow(
      /literal 127\.0\.0\.1 or ::1/,
    );

    const slashRootServer = await startSessionServer({
      host: "127.0.0.1",
      port: 0,
      roots,
      basePath: "/",
    });
    try {
      const slashRoot = await fetch(`http://127.0.0.1:${slashRootServer.address().port}/`);
      expect(slashRoot.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(slashRoot.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      await new Promise((resolve) => slashRootServer.close(resolve));
    }
  });

  it("accepts one exact HTTPS public origin for a trusted reverse proxy", async () => {
    const publicOrigin = "https://agent-session.example.ts.net";
    const publicServer = await startSessionServer({
      host: "127.0.0.1",
      port: 0,
      roots,
      publicOrigin,
    });
    const localUrl = `http://127.0.0.1:${publicServer.address().port}/api/sessions?limit=1`;
    try {
      const accepted = await requestStatus(localUrl, {
        Host: "agent-session.example.ts.net",
        Origin: publicOrigin,
      });
      expect(accepted).toBe(200);
      const wrongOrigin = await requestStatus(localUrl, {
        Host: "agent-session.example.ts.net",
        Origin: "https://attacker.invalid",
      });
      expect(wrongOrigin).toBe(403);
      const downgradedOrigin = await requestStatus(localUrl, {
        Host: "agent-session.example.ts.net",
        Origin: "http://agent-session.example.ts.net",
      });
      expect(downgradedOrigin).toBe(403);
      const nativeClient = await requestStatus(localUrl, {
        Host: "agent-session.example.ts.net",
      });
      expect(nativeClient).toBe(200);
      const publicHealthUrl =
        `http://127.0.0.1:${publicServer.address().port}/healthz`;
      expect(await requestStatus(publicHealthUrl, {
        Host: "agent-session.example.ts.net",
      })).toBe(200);
      const wrongHost = await requestStatus(localUrl, {
        Host: "other.example.ts.net",
        Origin: publicOrigin,
      });
      expect(wrongHost).toBe(403);
      const wrongPort = await requestStatus(localUrl, {
        Host: "agent-session.example.ts.net:8443",
        Origin: publicOrigin,
      });
      expect(wrongPort).toBe(403);
    } finally {
      await new Promise((resolve) => publicServer.close(resolve));
    }
    await expect(
      startSessionServer({
        host: "127.0.0.1",
        port: 0,
        roots,
        publicOrigin: "http://agent-session.example.ts.net/path",
      }),
    ).rejects.toThrow(/HTTPS origin/);
    const canonicalServer = await startSessionServer({
      host: "127.0.0.1",
      port: 0,
      roots,
      publicOrigin: "https://Agent-Session.EXAMPLE.ts.net:443/",
    });
    try {
      expect(
        await requestStatus(
          `http://127.0.0.1:${canonicalServer.address().port}/api/sessions?limit=1`,
          {
            Host: "agent-session.example.ts.net",
            Origin: "https://agent-session.example.ts.net",
          },
        ),
      ).toBe(200);
    } finally {
      await new Promise((resolve) => canonicalServer.close(resolve));
    }
  });

  it("serves the complete API under one canonical base path", async () => {
    const publicOrigin = "https://cockpit.example.ts.net";
    const prefixedServer = await startSessionServer({
      host: "127.0.0.1",
      port: 0,
      roots,
      publicOrigin,
      basePath: "/agent-session/",
    });
    const prefixedBase = `http://127.0.0.1:${prefixedServer.address().port}`;
    try {
      const redirect = await fetch(`${prefixedBase}/agent-session`, { redirect: "manual" });
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get("location")).toBe("/agent-session/");
      const queryRedirect = await fetch(`${prefixedBase}/agent-session?limit=5&x=1`, {
        redirect: "manual",
      });
      expect(queryRedirect.headers.get("location")).toBe("/agent-session/?limit=5&x=1");

      const index = await fetch(`${prefixedBase}/agent-session/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(index.headers.get("x-frame-options")).toBe("DENY");
      expect(await index.json()).toMatchObject({
        api_version: 1,
        kind: "agent-session-service",
      });
      const health = await fetch(`${prefixedBase}/agent-session/healthz`);
      expect(await health.json()).toMatchObject({
        api_version: 1,
        kind: "agent-session-health",
        status: "ok",
      });
      expect((await fetch(`${prefixedBase}/agent-session/index.html`)).status).toBe(404);
      expect((await fetch(`${prefixedBase}/agent-session/style.css`)).status).toBe(404);
      const head = await fetch(`${prefixedBase}/agent-session/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect((await fetch(`${prefixedBase}/agent-session/app.js`)).status).toBe(404);

      const list = await fetch(`${prefixedBase}/agent-session/api/sessions?limit=1`);
      expect(list.status).toBe(200);
      expect((await list.json()).data[0].native_session_id).toBe(CODEX_ID);
      expect((await fetch(`${prefixedBase}/api/sessions?limit=1`)).status).toBe(404);

      expect(
        await requestStatus(`${prefixedBase}/agent-session/api/sessions?limit=1`, {
          Host: "cockpit.example.ts.net",
          Origin: publicOrigin,
        }),
      ).toBe(200);
    } finally {
      await new Promise((resolve) => prefixedServer.close(resolve));
    }

    await expect(
      startSessionServer({ host: "127.0.0.1", port: 0, roots, basePath: "/../private" }),
    ).rejects.toThrow(/base path/);
  });

});

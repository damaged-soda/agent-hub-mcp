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
  server = await startSessionServer({ host: "127.0.0.1", port: 0, roots });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe("agent session server", () => {
  it("serves a no-store same-origin UI with a restrictive CSP", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toContain("Agent 会话检查器");
    const app = await (await fetch(`${baseUrl}/app.js`)).text();
    expect(app).toContain("reveal-confirm");
    expect(app).not.toContain("window.confirm");
  });

  it("keeps API bodies hidden until inspect is explicit", async () => {
    const list = await fetch(`${baseUrl}/api/sessions?limit=10`);
    expect(list.status).toBe(200);
    expect((await list.json()).data[0].native_session_id).toBe(CODEX_ID);

    const metadata = await fetch(
      `${baseUrl}/api/sessions/codex/${CODEX_ID}?profile=metadata&limit=100`,
    );
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(await metadata.text()).not.toContain("Private developer prompt");

    const inspect = await fetch(
      `${baseUrl}/api/sessions/codex/${CODEX_ID}?profile=inspect&limit=100`,
    );
    expect(await inspect.text()).toContain("Private developer prompt");
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

  it("serves the complete inspector under one canonical base path", async () => {
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
      expect(index.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
      expect(index.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(await index.text()).toContain('src="./app.js"');
      expect((await fetch(`${prefixedBase}/agent-session/index.html`)).status).toBe(200);
      expect((await fetch(`${prefixedBase}/agent-session/style.css`)).status).toBe(200);
      const head = await fetch(`${prefixedBase}/agent-session/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const app = await fetch(`${prefixedBase}/agent-session/app.js`);
      expect(app.status).toBe(200);
      const appText = await app.text();
      expect(appText).toContain("document.baseURI");
      expect(appText).not.toContain('fetch("/api/');
      expect(appText).not.toContain("window.location.origin");

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

  it("admits one exact HTTPS frame origin only for a prefixed inspector", async () => {
    const frameOrigin = "https://preview.example.ts.net:24443";
    const framedServer = await startSessionServer({
      host: "127.0.0.1",
      port: 0,
      roots,
      basePath: "/agent-session",
      frameOrigin,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${framedServer.address().port}/agent-session/`,
      );
      expect(response.headers.get("content-security-policy")).toContain(
        `frame-ancestors ${frameOrigin}`,
      );
      expect(response.headers.get("x-frame-options")).toBeNull();
    } finally {
      await new Promise((resolve) => framedServer.close(resolve));
    }

    await expect(
      startSessionServer({ host: "127.0.0.1", port: 0, roots, frameOrigin }),
    ).rejects.toThrow(/requires a non-root base path/);
    await expect(
      startSessionServer({
        host: "127.0.0.1",
        port: 0,
        roots,
        basePath: "/agent-session",
        frameOrigin: "http://preview.example.ts.net",
      }),
    ).rejects.toThrow(/frame origin/);
    await expect(
      startSessionServer({
        host: "127.0.0.1",
        port: 0,
        roots,
        basePath: "/agent-session",
        frameOrigin: "https://*.example.ts.net",
      }),
    ).rejects.toThrow(/frame origin/);
  });
});

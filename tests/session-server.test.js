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
      /loopback/,
    );
    await expect(startSessionServer({ host: "localhost", port: 0, roots })).rejects.toThrow(
      /loopback/,
    );
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
      const wrongHost = await requestStatus(localUrl, {
        Host: "other.example.ts.net",
        Origin: publicOrigin,
      });
      expect(wrongHost).toBe(403);
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
  });
});

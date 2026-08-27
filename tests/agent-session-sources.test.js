import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverNativeSessions, inspectNativeSession } from "../src/agent-session-sources.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "agent-session");
const CLAUDE_ID = "550e8400-e29b-41d4-a716-446655440000";
const CODEX_ID = "01a03dc9-2a7e-76a2-b03d-39e06e22a5b6";
const KIMI_ID = "session_437f4ac7-19f4-472b-be3c-a87be0f41419";

let tempRoot;
let roots;
let sourcePaths;

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-session-sources-"));
  roots = {
    claude: path.join(tempRoot, "claude"),
    codex: path.join(tempRoot, "codex"),
    kimi: path.join(tempRoot, "kimi"),
  };
  const claudePath = path.join(roots.claude, "projects", "-workspace-example", `${CLAUDE_ID}.jsonl`);
  const codexPath = path.join(
    roots.codex,
    "sessions",
    "2026",
    "08",
    "26",
    `rollout-2026-08-26T10-00-00-${CODEX_ID}.jsonl`,
  );
  const kimiDir = path.join(roots.kimi, "sessions", "wd_example", KIMI_ID);
  const kimiPath = path.join(kimiDir, "agents", "main", "wire.jsonl");
  await Promise.all([
    fsp.mkdir(path.dirname(claudePath), { recursive: true }),
    fsp.mkdir(path.dirname(codexPath), { recursive: true }),
    fsp.mkdir(path.dirname(kimiPath), { recursive: true }),
  ]);
  await Promise.all([
    fsp.copyFile(path.join(fixtureRoot, "claude-transcript.jsonl"), claudePath),
    fsp.copyFile(path.join(fixtureRoot, "codex-transcript.jsonl"), codexPath),
    fsp.copyFile(path.join(fixtureRoot, "kimi-transcript.jsonl"), kimiPath),
    fsp.writeFile(
      path.join(kimiDir, "state.json"),
      JSON.stringify({ id: KIMI_ID, cwd: "/workspace/example", title: "检查 Kimi 会话" }),
    ),
  ]);
  await fsp.appendFile(
    claudePath,
    `\n${JSON.stringify({ type: "ai-title", sessionId: CLAUDE_ID, aiTitle: "检查 Claude 会话" })}\n`,
  );
  await fsp.writeFile(
    path.join(roots.codex, "session_index.jsonl"),
    `${JSON.stringify({ id: CODEX_ID, thread_name: "检查 Codex 会话" })}\n`,
  );
  await fsp.writeFile(
    path.join(roots.kimi, "session_index.jsonl"),
    `${JSON.stringify({ sessionId: KIMI_ID, sessionDir: kimiDir, workDir: "/workspace/example" })}\n`,
  );
  sourcePaths = { claudePath, codexPath, kimiPath };
});

afterEach(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe("native session sources", () => {
  it("discovers provider-native sessions without an Agent Hub run", async () => {
    const sessions = await discoverNativeSessions({ roots, limit: 10 });
    expect(sessions.map((item) => item.provider).sort()).toEqual(["claude", "codex", "kimi"]);
    expect(sessions.find((item) => item.provider === "claude")).toMatchObject({
      native_session_id: CLAUDE_ID,
      title: "检查 Claude 会话",
      cwd: "/workspace/example",
      source_kind: "claude-transcript",
    });
    expect(sessions.find((item) => item.provider === "codex")).toMatchObject({
      native_session_id: CODEX_ID,
      title: "检查 Codex 会话",
      cwd: "/workspace/example",
      source_kind: "codex-rollout",
    });
    expect(sessions.find((item) => item.provider === "kimi")).toMatchObject({
      native_session_id: KIMI_ID,
      title: "检查 Kimi 会话",
      cwd: "/workspace/example",
      source_kind: "kimi-wire",
    });
  });

  it("rejects Kimi index entries that point outside the configured root", async () => {
    const outsideId = "session_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const outsideDir = path.join(tempRoot, "outside", outsideId);
    await fsp.mkdir(path.join(outsideDir, "agents", "main"), { recursive: true });
    await fsp.copyFile(
      path.join(fixtureRoot, "kimi-transcript.jsonl"),
      path.join(outsideDir, "agents", "main", "wire.jsonl"),
    );
    await fsp.appendFile(
      path.join(roots.kimi, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: outsideId, sessionDir: outsideDir, workDir: "/outside" })}\n`,
    );
    const sessions = await discoverNativeSessions({ roots, provider: "kimi", limit: 10 });
    expect(sessions.map((item) => item.native_session_id)).toEqual([KIMI_ID]);
  });

  it("uses metadata by default and requires inspect profile for transcript bodies", async () => {
    const metadata = await inspectNativeSession(
      { provider: "codex", native_session_id: CODEX_ID, limit: 100 },
      { roots },
    );
    expect(metadata.profile).toBe("metadata");
    expect(JSON.stringify(metadata)).not.toContain("Private developer prompt");
    expect(metadata.data.some((event) => event.data.content_bytes > 0)).toBe(true);

    const inspect = await inspectNativeSession(
      {
        provider: "codex",
        native_session_id: CODEX_ID,
        profile: "inspect",
        after: 0,
        limit: 100,
      },
      { roots },
    );
    expect(JSON.stringify(inspect)).toContain("Private developer prompt");
    expect(inspect.next_sequence).toBe(inspect.data.at(-1).sequence + 1);
  });

  it("supports bounded cursor reads and leaves provider files untouched", async () => {
    const before = await Promise.all(Object.values(sourcePaths).map((item) => fsp.stat(item)));
    const first = await inspectNativeSession(
      { provider: "kimi", native_session_id: KIMI_ID, profile: "inspect", limit: 2 },
      { roots },
    );
    expect(first.data).toHaveLength(2);
    expect(first.has_more).toBe(true);
    const second = await inspectNativeSession(
      {
        provider: "kimi",
        native_session_id: KIMI_ID,
        profile: "inspect",
        after: first.next_sequence,
        limit: 100,
      },
      { roots },
    );
    expect(second.data[0].sequence).toBe(first.next_sequence);
    const after = await Promise.all(Object.values(sourcePaths).map((item) => fsp.stat(item)));
    expect(after.map((item) => item.mtimeMs)).toEqual(before.map((item) => item.mtimeMs));
    expect(after.map((item) => item.size)).toEqual(before.map((item) => item.size));
  });

  it("exposes the same contract through a side-effect-free CLI", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "src", "session-cli.js"), "list", "--limit", "10"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: roots.claude,
          CODEX_HOME: roots.codex,
          KIMI_CODE_HOME: roots.kimi,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const document = JSON.parse(result.stdout);
    expect(document.kind).toBe("agent-session-list");
    expect(document.data).toHaveLength(3);
  });
});

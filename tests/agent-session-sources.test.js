import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverNativeSessions,
  inspectNativeSession,
  resolveNativeSessionEventReference,
  resolveNativeSessionReference,
} from "../src/agent-session-sources.js";

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
      JSON.stringify({
        id: KIMI_ID,
        cwd: "/workspace/example",
        title: "检查 Kimi 会话",
        isCustomTitle: true,
      }),
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
      session_ref: `agenthub://session/v1/codex/${CODEX_ID}`,
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

  it("normalizes bounded titles and keeps missing titles explicit", async () => {
    await fsp.writeFile(
      path.join(roots.codex, "session_index.jsonl"),
      `${JSON.stringify({ id: CODEX_ID, thread_name: `  标题  换行\n${"x".repeat(300)}` })}\n`,
    );
    let sessions = await discoverNativeSessions({ roots, provider: "codex", limit: 10 });
    expect(sessions[0].title).toHaveLength(256);
    expect(sessions[0].title).toMatch(/^标题 换行 x+$/);

    await fsp.writeFile(
      path.join(roots.codex, "session_index.jsonl"),
      `${JSON.stringify({ id: CODEX_ID, thread_name: " \n " })}\n`,
    );
    sessions = await discoverNativeSessions({ roots, provider: "codex", limit: 10 });
    expect(sessions[0].title).toBeNull();
  });

  it("uses only recent Claude ai-title metadata", async () => {
    await fsp.appendFile(
      sourcePaths.claudePath,
      `${JSON.stringify({ type: "ai-title", sessionId: CLAUDE_ID, aiTitle: "更新后的标题" })}\n`,
    );
    let sessions = await discoverNativeSessions({ roots, provider: "claude", limit: 10 });
    expect(sessions[0].title).toBe("更新后的标题");

    await fsp.appendFile(
      sourcePaths.claudePath,
      `${JSON.stringify({ type: "noise", value: "x".repeat(64 * 1024) })}\n`,
    );
    sessions = await discoverNativeSessions({ roots, provider: "claude", limit: 10 });
    expect(sessions[0].title).toBeNull();
  });

  it("does not expose Kimi automatic prompt titles", async () => {
    await fsp.writeFile(
      path.join(path.dirname(path.dirname(path.dirname(sourcePaths.kimiPath))), "state.json"),
      JSON.stringify({
        cwd: "/workspace/example",
        title: "这是第一条 prompt 的原文",
        isCustomTitle: false,
      }),
    );
    const sessions = await discoverNativeSessions({ roots, provider: "kimi", limit: 10 });
    expect(sessions[0].title).toBeNull();
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
    expect(inspect.data.every((event) => event.event_ref?.startsWith(
      `agenthub://session/v1/codex/${CODEX_ID}/event/e1_`,
    ))).toBe(true);
    expect(metadata.data.map((event) => event.event_ref)).toEqual(
      inspect.data.map((event) => event.event_ref),
    );
  });

  it("resolves one copied event into a bounded diagnostic package", async () => {
    const inspect = await inspectNativeSession(
      {
        provider: "codex",
        native_session_id: CODEX_ID,
        profile: "inspect",
        limit: 100,
      },
      { roots },
    );
    const call = inspect.data.find((event) => event.kind === "tool-call");
    const resolved = await resolveNativeSessionEventReference(call.event_ref, { roots });
    expect(resolved).toMatchObject({
      api_version: 1,
      kind: "agent-session-event-resolution",
      reference: call.event_ref,
      reference_protocol: { version: 1, event_id_version: 1 },
      session: { provider: "codex", native_session_id: CODEX_ID },
      data: {
        target: { event_ref: call.event_ref, kind: "tool-call" },
        effective_context: { kind: "context" },
      },
    });
    expect(resolved.data.target.data.arguments).toEqual({ command: "git status --short" });
    expect(resolved.data.related).toEqual([
      expect.objectContaining({
        kind: "tool-result",
        data: expect.objectContaining({ tool_call_id: call.data.tool_call_id }),
      }),
    ]);
    expect(resolved.data.effective_context.data.cwd).toBe("/workspace/example");

    const stale = call.event_ref.replace(/.$/, call.event_ref.endsWith("a") ? "b" : "a");
    await expect(resolveNativeSessionEventReference(stale, { roots })).rejects.toThrow(/Stale/);
  });

  it("resolves one copied session reference without eagerly reading transcript bodies", async () => {
    const reference = `agenthub://session/v1/codex/${CODEX_ID}`;
    const resolved = await resolveNativeSessionReference(reference, { roots });
    expect(resolved).toMatchObject({
      api_version: 1,
      kind: "agent-session-resolution",
      reference,
      reference_protocol: { version: 1 },
      session: {
        provider: "codex",
        native_session_id: CODEX_ID,
        session_ref: reference,
        title: "检查 Codex 会话",
      },
    });
    expect(resolved).not.toHaveProperty("data");
    expect(JSON.stringify(resolved)).not.toContain("Private developer prompt");
  });

  it("accepts identical session copies but rejects conflicting transcript sources", async () => {
    const archivedPath = path.join(
      roots.codex,
      "archived_sessions",
      `rollout-copy-${CODEX_ID}.jsonl`,
    );
    await fsp.mkdir(path.dirname(archivedPath), { recursive: true });
    await fsp.copyFile(sourcePaths.codexPath, archivedPath);

    const inspect = await inspectNativeSession(
      { provider: "codex", native_session_id: CODEX_ID, profile: "inspect", limit: 100 },
      { roots },
    );
    expect(inspect.session).toMatchObject({
      source_kind: "codex-rollout",
      duplicate_source_count: 2,
    });
    const reference = inspect.data.find((event) => event.kind === "tool-call").event_ref;

    const divergent = (await fsp.readFile(archivedPath, "utf8")).replace(
      "/workspace/example",
      "/workspace/conflict",
    );
    await fsp.writeFile(archivedPath, divergent);
    await expect(inspectNativeSession(
      { provider: "codex", native_session_id: CODEX_ID, profile: "inspect", limit: 100 },
      { roots },
    )).rejects.toThrow(/Ambiguous.*conflicting transcript sources/);
    await expect(resolveNativeSessionEventReference(reference, { roots })).rejects.toThrow(
      /Ambiguous.*conflicting transcript sources/,
    );
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

  it("exposes list and event resolution through a side-effect-free CLI", async () => {
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

    const sessionResolved = spawnSync(
      process.execPath,
      [path.join(repoRoot, "src", "session-cli.js"), "resolve", document.data[0].session_ref],
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
    expect(sessionResolved.status, sessionResolved.stderr).toBe(0);
    expect(JSON.parse(sessionResolved.stdout)).toMatchObject({
      kind: "agent-session-resolution",
      reference: document.data[0].session_ref,
    });

    const inspect = await inspectNativeSession(
      { provider: "codex", native_session_id: CODEX_ID, profile: "inspect", limit: 100 },
      { roots },
    );
    const reference = inspect.data.find((event) => event.kind === "tool-call").event_ref;
    const resolved = spawnSync(
      process.execPath,
      [path.join(repoRoot, "src", "session-cli.js"), "resolve", reference],
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
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout)).toMatchObject({
      kind: "agent-session-event-resolution",
      reference,
    });
  });
});

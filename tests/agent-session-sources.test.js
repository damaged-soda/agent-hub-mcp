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
const OPENCODE_ID = "ses_01a03dc9bffezOpenCodeFixture";

let tempRoot;
let roots;
let sourcePaths;

function openCodeSessionRow(info) {
  return {
    id: info.id,
    project_id: "project-fixture",
    slug: "fixture-session",
    directory: info.directory,
    path: "",
    title: info.title,
    version: "1.18.25",
    summary_additions: 0,
    summary_deletions: 0,
    summary_files: 0,
    summary_diffs: "[]",
    cost: 0,
    tokens_input: 16,
    tokens_output: 5,
    tokens_reasoning: 2,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    permission: "[]",
    agent: info.agent,
    model: JSON.stringify(info.model),
    time_created: info.time.created,
    time_updated: info.time.updated,
  };
}

function openCodeMessageRows(messages) {
  return messages.map((item) => {
    const { id, sessionID, ...data } = item.info;
    return {
      id,
      session_id: sessionID,
      time_created: item.info.time?.created ?? 0,
      time_updated: item.info.time?.completed ?? item.info.time?.created ?? 0,
      data: JSON.stringify(data),
    };
  });
}

function openCodePartRows(messages) {
  return messages.flatMap((item) => item.parts.map((part) => {
    const { id, messageID, sessionID, ...data } = part;
    return {
      id,
      message_id: messageID,
      session_id: sessionID,
      time_created: part.time?.start ?? item.info.time?.created ?? 0,
      time_updated: part.time?.end ?? part.time?.start ?? item.info.time?.created ?? 0,
      data: JSON.stringify(data),
    };
  }));
}

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-session-sources-"));
  roots = {
    claude: path.join(tempRoot, "claude"),
    codex: path.join(tempRoot, "codex"),
    kimi: path.join(tempRoot, "kimi"),
    opencode: path.join(tempRoot, "opencode"),
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

  it("searches the whole directory instead of only the returned page", async () => {
    const recent = new Date("2026-08-27T10:00:00.000Z");
    const older = new Date("2026-08-20T10:00:00.000Z");
    await fsp.utimes(sourcePaths.kimiPath, recent, recent);
    await fsp.utimes(sourcePaths.codexPath, recent, recent);
    await fsp.utimes(sourcePaths.claudePath, older, older);

    const page = await discoverNativeSessions({ roots, limit: 1 });
    expect(page).toHaveLength(1);
    expect(page.map((item) => item.provider)).not.toContain("claude");
    expect(page.total_discovered).toBe(3);
    expect(page.matched).toBe(3);
    expect(page.query).toBe(null);

    const hits = await discoverNativeSessions({ roots, limit: 1, query: "Claude 会话" });
    expect(hits.map((item) => item.native_session_id)).toEqual([CLAUDE_ID]);
    expect(hits.total_discovered).toBe(3);
    expect(hits.matched).toBe(1);
    expect(hits.query).toBe("claude 会话");
  });

  it("reports the full match count even when the page truncates it", async () => {
    const sessions = await discoverNativeSessions({ roots, limit: 1, query: "会话" });
    expect(sessions).toHaveLength(1);
    expect(sessions.matched).toBe(3);
    expect(sessions.total_discovered).toBe(3);
  });

  it("matches cwd and native session id as well as the native title", async () => {
    const byCwd = await discoverNativeSessions({ roots, limit: 10, query: "/workspace/example" });
    expect(byCwd.matched).toBe(3);
    const byId = await discoverNativeSessions({ roots, limit: 10, query: CODEX_ID.toUpperCase() });
    expect(byId.map((item) => item.native_session_id)).toEqual([CODEX_ID]);
    const byProvider = await discoverNativeSessions({ roots, limit: 10, query: "kimi" });
    expect(byProvider.map((item) => item.provider)).toEqual(["kimi"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps one unreadable transcript from failing the whole search",
    async () => {
      const brokenId = "770e8400-e29b-41d4-a716-4466554400ff";
      const brokenPath = path.join(
        roots.claude, "projects", "-workspace-example", `${brokenId}.jsonl`,
      );
      await fsp.copyFile(sourcePaths.claudePath, brokenPath);
      await fsp.chmod(brokenPath, 0o000);
      try {
        const sessions = await discoverNativeSessions({
          roots, limit: 10, query: "claude",
        });
        expect(sessions.total_discovered).toBe(4);
        expect(sessions.map((item) => item.native_session_id)).toContain(CLAUDE_ID);
        const broken = sessions.find((item) => item.native_session_id === brokenId);
        expect(broken).toMatchObject({ provider: "claude", cwd: null, title: null });
        expect(sessions.source_errors).toEqual([
          expect.objectContaining({
            provider: "claude",
            code: "session_metadata_unreadable",
          }),
        ]);
      } finally {
        await fsp.chmod(brokenPath, 0o600);
        await fsp.rm(brokenPath, { force: true });
      }
    },
  );

  it("treats a blank query as no query and rejects an unbounded one", async () => {
    const blank = await discoverNativeSessions({ roots, limit: 10, query: "   " });
    expect(blank.query).toBe(null);
    expect(blank.matched).toBe(3);
    await expect(discoverNativeSessions({ roots, limit: 10, query: "x".repeat(201) }))
      .rejects.toThrow("query must be at most 200 characters");
    await expect(discoverNativeSessions({ roots, limit: 10, query: 7 }))
      .rejects.toThrow("query must be a string");
  });

  it("keeps scanning Claude metadata after timestamp-only preamble records", async () => {
    const createdAt = "2026-08-26T09:59:00.000Z";
    await fsp.writeFile(
      sourcePaths.claudePath,
      [
        { type: "queue-operation", sessionId: CLAUDE_ID, timestamp: createdAt },
        {
          type: "attachment",
          sessionId: CLAUDE_ID,
          timestamp: "2026-08-26T10:00:00.000Z",
          cwd: "/workspace/preamble",
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const sessions = await discoverNativeSessions({ roots, provider: "claude", limit: 10 });
    expect(sessions[0]).toMatchObject({
      cwd: "/workspace/preamble",
      created_at: createdAt,
    });
  });

  it("keeps Claude transcript time when cwd is never observed", async () => {
    const createdAt = "2026-08-26T09:59:00.000Z";
    await fsp.writeFile(
      sourcePaths.claudePath,
      [
        { type: "queue-operation", sessionId: CLAUDE_ID, timestamp: createdAt },
        {
          type: "queue-operation",
          sessionId: CLAUDE_ID,
          timestamp: "2026-08-26T10:00:00.000Z",
        },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    );

    const sessions = await discoverNativeSessions({ roots, provider: "claude", limit: 10 });
    expect(sessions[0]).toMatchObject({ cwd: null, created_at: createdAt });
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

  it("discovers and inspects OpenCode sessions through read-only management commands", async () => {
    await fsp.mkdir(roots.opencode, { recursive: true });
    const databasePath = path.join(roots.opencode, "opencode.db");
    await fsp.writeFile(databasePath, "fixture-db");
    const exported = JSON.parse(
      await fsp.readFile(path.join(fixtureRoot, "opencode-export.json"), "utf8"),
    );
    const sessionRow = openCodeSessionRow(exported.info);
    const messageRows = openCodeMessageRows(exported.messages);
    const partRows = openCodePartRows(exported.messages);
    const calls = [];
    const sqliteCommand = async (args) => {
      calls.push(args);
      const query = args.at(-1);
      const rows = query.includes("where id =")
        ? [sessionRow]
        : query.includes("from message where")
          ? messageRows
          : query.includes("from part where")
            ? partRows
            : [sessionRow];
      return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
    };

    const sessions = await discoverNativeSessions({
      roots,
      provider: "opencode",
      limit: 10,
      sqliteCommand,
    });
    expect(sessions).toEqual([
      expect.objectContaining({
        provider: "opencode",
        native_session_id: OPENCODE_ID,
        session_ref: `agenthub://session/v1/opencode/${OPENCODE_ID}`,
        title: "检查 OpenCode 会话",
        cwd: "/workspace/example",
        source_kind: "opencode-export",
        source_path: databasePath,
      }),
    ]);

    const metadata = await inspectNativeSession(
      { provider: "opencode", native_session_id: OPENCODE_ID, limit: 100 },
      { roots, sqliteCommand },
    );
    expect(metadata.profile).toBe("metadata");
    expect(JSON.stringify(metadata)).not.toContain("Private OpenCode prompt");
    expect(JSON.stringify(metadata)).not.toContain("hidden OpenCode reasoning");
    const inspect = await inspectNativeSession(
      {
        provider: "opencode",
        native_session_id: OPENCODE_ID,
        profile: "inspect",
        limit: 100,
      },
      { roots, sqliteCommand },
    );
    expect(JSON.stringify(inspect)).toContain("Private OpenCode prompt");
    expect(JSON.stringify(inspect)).not.toContain("hidden OpenCode reasoning");
    const firstPage = await inspectNativeSession(
      {
        provider: "opencode",
        native_session_id: OPENCODE_ID,
        profile: "inspect",
        limit: 2,
      },
      { roots, sqliteCommand },
    );
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.has_more).toBe(true);
    const secondPage = await inspectNativeSession(
      {
        provider: "opencode",
        native_session_id: OPENCODE_ID,
        profile: "inspect",
        after: firstPage.next_sequence,
        limit: 100,
      },
      { roots, sqliteCommand },
    );
    expect(secondPage.data[0].sequence).toBe(firstPage.next_sequence);
    const call = inspect.data.find((event) => event.kind === "tool-call");
    expect(call.event_ref).toMatch(
      new RegExp(`^agenthub://session/v1/opencode/${OPENCODE_ID}/event/e1_`),
    );
    const resolved = await resolveNativeSessionEventReference(call.event_ref, {
      roots,
      sqliteCommand,
    });
    expect(resolved.data.target.data.arguments).toEqual({
      command: "git status --short",
      workdir: "/workspace/example",
    });
    expect(resolved.data.related).toEqual([
      expect.objectContaining({
        kind: "tool-result",
        data: expect.objectContaining({ tool_call_id: "call_opencode_1" }),
      }),
    ]);
    expect(calls.every((args) => args.slice(0, 3).join(" ").startsWith("-readonly -json ")))
      .toBe(true);
  });

  it("keeps healthy providers visible when implicit OpenCode discovery fails", async () => {
    await fsp.mkdir(roots.opencode, { recursive: true });
    await fsp.writeFile(path.join(roots.opencode, "opencode.db"), "fixture-db");
    const sqliteCommand = async () => ({
      code: 1,
      stdout: "",
      stderr: "no such column: time_updated",
    });
    const sessions = await discoverNativeSessions({ roots, limit: 10, sqliteCommand });
    expect(sessions.map((item) => item.provider).sort()).toEqual(["claude", "codex", "kimi"]);
    expect(sessions.source_errors).toEqual([
      expect.objectContaining({
        provider: "opencode",
        code: "source_unavailable",
        message: expect.stringContaining("no such column"),
      }),
    ]);
    await expect(discoverNativeSessions({
      roots,
      provider: "opencode",
      limit: 10,
      sqliteCommand,
    })).rejects.toThrow(/no such column/);
  });

  it("counts malformed OpenCode rows while preserving valid transcript events", async () => {
    await fsp.mkdir(roots.opencode, { recursive: true });
    await fsp.writeFile(path.join(roots.opencode, "opencode.db"), "fixture-db");
    const exported = JSON.parse(
      await fsp.readFile(path.join(fixtureRoot, "opencode-export.json"), "utf8"),
    );
    const sessionRow = openCodeSessionRow(exported.info);
    const messageRows = [
      ...openCodeMessageRows(exported.messages),
      { id: "msg_bad", session_id: OPENCODE_ID, time_created: 1, time_updated: 1, data: "{" },
    ];
    const partRows = [
      ...openCodePartRows(exported.messages),
      {
        id: "prt_orphan",
        message_id: "msg_missing",
        session_id: OPENCODE_ID,
        time_created: 1,
        time_updated: 1,
        data: JSON.stringify({ type: "text", text: "orphan" }),
      },
    ];
    const sqliteCommand = async (args) => {
      const query = args.at(-1);
      const rows = query.includes("where id =")
        ? [sessionRow]
        : query.includes("from message where")
          ? messageRows
          : query.includes("from part where")
            ? partRows
            : [sessionRow];
      return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
    };
    const inspect = await inspectNativeSession(
      { provider: "opencode", native_session_id: OPENCODE_ID, profile: "inspect", limit: 100 },
      { roots, sqliteCommand },
    );
    expect(inspect.malformed_lines).toBe(2);
    expect(JSON.stringify(inspect)).toContain("OpenCode result");
    expect(JSON.stringify(inspect)).not.toContain("orphan");
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
          XDG_DATA_HOME: tempRoot,
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
          XDG_DATA_HOME: tempRoot,
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
          XDG_DATA_HOME: tempRoot,
        },
      },
    );
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout)).toMatchObject({
      kind: "agent-session-event-resolution",
      reference,
    });
  });

  it("reads large OpenCode list and inspect payloads through sqlite3 without pipe truncation", async () => {
    const binDir = path.join(tempRoot, "bin");
    const dataRoot = path.join(tempRoot, "opencode-data");
    const databaseDir = path.join(dataRoot, "opencode");
    await fsp.mkdir(binDir, { recursive: true });
    await fsp.mkdir(databaseDir, { recursive: true });
    await fsp.writeFile(path.join(databaseDir, "opencode.db"), "fixture-db");
    const exported = JSON.parse(await fsp.readFile(
      path.join(fixtureRoot, "opencode-export.json"), "utf8"));
    const sessionRow = openCodeSessionRow(exported.info);
    const listRows = Array.from({ length: 400 }, (_, index) => ({
      ...sessionRow,
      id: index === 0 ? OPENCODE_ID : `ses_fixture${String(index).padStart(6, "0")}`,
      title: `${"OpenCode fixture session ".repeat(8)}${index}`,
      time_created: sessionRow.time_created - index,
      time_updated: sessionRow.time_updated - index,
    }));
    const messageRows = openCodeMessageRows(exported.messages);
    const partRows = openCodePartRows(exported.messages).map((row) => {
      const data = JSON.parse(row.data);
      if (data.type === "tool") data.state.output = "x".repeat(200000);
      return { ...row, data: JSON.stringify(data) };
    });
    await fsp.writeFile(
      path.join(binDir, "sqlite3"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const query = args.at(-1);
const rows = query.includes("where id =")
  ? ${JSON.stringify([sessionRow])}
  : query.includes("from message where")
    ? ${JSON.stringify(messageRows)}
    : query.includes("from part where")
      ? ${JSON.stringify(partRows)}
      : ${JSON.stringify(listRows)};
process.stdout.write(JSON.stringify(rows));
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      XDG_DATA_HOME: dataRoot,
    };
    const listed = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "src", "session-cli.js"),
        "list",
        "--provider",
        "opencode",
        "--limit",
        "10",
      ],
      { encoding: "utf8", env },
    );
    expect(listed.status, listed.stderr).toBe(0);
    const listedDocument = JSON.parse(listed.stdout);
    expect(listedDocument.data).toHaveLength(10);
    expect(listedDocument.data[0]).toMatchObject({
      provider: "opencode",
      native_session_id: OPENCODE_ID,
      size_bytes: null,
    });

    const inspected = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "src", "session-cli.js"),
        "inspect",
        "--provider",
        "opencode",
        "--session-id",
        OPENCODE_ID,
        "--profile",
        "inspect",
        "--limit",
        "100",
      ],
      { encoding: "utf8", env },
    );
    expect(inspected.status, inspected.stderr).toBe(0);
    const document = JSON.parse(inspected.stdout);
    expect(JSON.stringify(document)).toContain("Private OpenCode prompt");
    expect(JSON.stringify(document)).not.toContain("hidden OpenCode reasoning");
    expect(document.data.some((event) => event.truncation?.truncated === true)).toBe(true);
  });
});

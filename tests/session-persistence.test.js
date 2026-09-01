import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeSessionRoot,
  preflightClaudeSessionPersistence,
  verifyClaudeSessionPersistence,
} from "../src/session-persistence.js";

describe("Claude session persistence guard", () => {
  let root;
  let env;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-session-persistence-"));
    env = { CLAUDE_CONFIG_DIR: root };
  });

  afterEach(async () => {
    await fsp.chmod(path.join(root, "projects"), 0o700).catch(() => undefined);
    await fsp.chmod(path.join(root, "session-env"), 0o700).catch(() => undefined);
    await fsp.chmod(path.join(root, "sessions"), 0o700).catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("preflights the directories Claude needs for a new resumable session", async () => {
    const result = await preflightClaudeSessionPersistence({
      env,
      nativeSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(result).toEqual({ root, transcript_path: null });
    await expect(fsp.stat(path.join(root, "projects"))).resolves.toBeDefined();
    await expect(fsp.stat(path.join(root, "session-env"))).resolves.toBeDefined();
    await expect(fsp.stat(path.join(root, "sessions"))).resolves.toBeDefined();
    await expect(
      fsp.readdir(path.join(root, "projects")),
    ).resolves.toEqual([]);
  });

  it("fails before dispatch when the native store is not writable", async () => {
    const projects = path.join(root, "projects");
    await fsp.mkdir(projects, { recursive: true });
    await fsp.chmod(projects, 0o500);

    await expect(
      preflightClaudeSessionPersistence({
        env,
        nativeSessionId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).rejects.toMatchObject({ code: "session_store_unwritable" });
  });

  it("requires an existing transcript when resuming", async () => {
    await expect(
      preflightClaudeSessionPersistence({
        env,
        nativeSessionId: "550e8400-e29b-41d4-a716-446655440000",
        resumed: true,
      }),
    ).rejects.toMatchObject({ code: "session_resume_unavailable" });
  });

  it("rejects non-UUID continuation ids before using them as paths", async () => {
    await expect(
      preflightClaudeSessionPersistence({
        env,
        nativeSessionId: "../../outside",
        resumed: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_session_ref" });
  });

  it("finds and verifies a persisted transcript", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const transcript = path.join(root, "projects", "-workspace-example", `${sessionId}.jsonl`);
    await fsp.mkdir(path.dirname(transcript), { recursive: true });
    await fsp.writeFile(transcript, '{"type":"system"}\n', { mode: 0o600 });

    await expect(
      preflightClaudeSessionPersistence({
        env,
        nativeSessionId: sessionId,
        resumed: true,
      }),
    ).resolves.toEqual({ root, transcript_path: transcript });
    await expect(
      verifyClaudeSessionPersistence({ env, nativeSessionId: sessionId }),
    ).resolves.toMatchObject({
      root,
      transcript_path: transcript,
      size_bytes: 18,
    });
  });

  it("rejects explicitly disabled persistence", async () => {
    await expect(
      preflightClaudeSessionPersistence({
        env: { ...env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" },
        nativeSessionId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).rejects.toMatchObject({ code: "session_persistence_disabled", retryable: false });
  });

  it("uses the configured root and defaults to ~/.claude", () => {
    expect(claudeSessionRoot({ CLAUDE_CONFIG_DIR: "/tmp/custom-claude" })).toBe(
      "/tmp/custom-claude",
    );
  });
});

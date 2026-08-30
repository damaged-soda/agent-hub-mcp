import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_PATCH_SCHEMA,
  buildEvalPrompt,
  canonicalizeExistingSourceLocation,
  cleanWorkspaceSnapshot,
  gradeSourceLocation,
  loadEvalSuite,
  normalizeExpectedVerifier,
  normalizeExpectedSourceLocation,
  parseSourceLocationOutput,
  verifierUnchanged,
} from "../src/eval-protocol.js";

const execFileAsync = promisify(execFile);

describe("eval protocol", () => {
  let root;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-eval-protocol-"));
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "Agent Hub Test");
    await fsp.mkdir(path.join(root, ".agenthub"));
    await fsp.mkdir(path.join(root, "src"));
    await fsp.writeFile(path.join(root, "src", "app.js"), "export function target() {}\n");
    await writeSuite(root);
    await git(root, "add", ".");
    await git(root, "commit", "-m", "fixture");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("loads questions without accepting repository-owned oracle fields", async () => {
    const suite = await loadEvalSuite(root);
    expect(suite).toMatchObject({
      schema_version: 1,
      suite_id: "code-navigation",
      relative_path: ".agenthub/evals.json",
      cases: [{ id: "locate-target", answer_schema: "source-location/v1" }],
    });
    expect(suite.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(suite.cases[0].question_digest).toMatch(/^[0-9a-f]{64}$/);

    await writeSuite(root, {
      cases: [{
        id: "locate-target",
        prompt: "Find the implementation.",
        answer_schema: "source-location/v1",
        expected: { path: "src/app.js", symbol: "target", definition_line: 1 },
      }],
    });
    await expect(loadEvalSuite(root)).rejects.toMatchObject({ code: "invalid_eval_suite" });
  });

  it("validates a repository-relative standard answer and exact output", async () => {
    const expected = await normalizeExpectedSourceLocation({
      path: "src/app.js",
      symbol: "target",
      definition_line: 1,
    }, root);
    const actual = parseSourceLocationOutput(
      '{"path":"src/app.js","symbol":"target","definition_line":1}',
    );
    expect(gradeSourceLocation(expected, actual)).toBe(true);
    expect(() => parseSourceLocationOutput("```json\n{}\n```")).toThrow(/one JSON object/);
    await expect(normalizeExpectedSourceLocation({
      path: "../outside.js",
      symbol: "target",
      definition_line: 1,
    }, root)).rejects.toMatchObject({ code: "invalid_eval_answer" });

    await fsp.symlink("app.js", path.join(root, "src", "alias.js"));
    const alias = await canonicalizeExistingSourceLocation({
      path: "src/alias.js",
      symbol: "target",
      definition_line: 1,
    }, root);
    expect(alias.path).toBe("src/app.js");
  });

  it("pins evaluation to a clean Git commit", async () => {
    const first = await cleanWorkspaceSnapshot(root);
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(first.workspace_digest).toMatch(/^[0-9a-f]{64}$/);
    await fsp.appendFile(path.join(root, "src", "app.js"), "// dirty\n");
    await expect(cleanWorkspaceSnapshot(root)).rejects.toMatchObject({
      code: "dirty_eval_workspace",
    });
  });

  it("adds only a public structured output contract to the question", async () => {
    const suite = await loadEvalSuite(root);
    const prompt = buildEvalPrompt(suite.cases[0]);
    expect(prompt).toContain("Find the implementation.");
    expect(prompt).toContain("definition_line");
    expect(prompt).not.toContain("target\"");
  });

  it("loads patch questions without repository-owned verifier fields", async () => {
    await writeSuite(root, {
      schema_version: 2,
      suite_id: "patch-eval",
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
      }],
    });
    const suite = await loadEvalSuite(root);
    expect(suite).toMatchObject({
      schema_version: 2,
      cases: [{ id: "change-target", answer_schema: "workspace-patch/v1" }],
    });
    expect(buildEvalPrompt(suite.cases[0])).toContain("Implement the requested change");

    await writeSuite(root, {
      schema_version: 2,
      suite_id: "patch-eval",
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
        verifier: "/tmp/hidden",
      }],
    });
    await expect(loadEvalSuite(root)).rejects.toMatchObject({ code: "invalid_eval_suite" });
  });

  it("pins an executable verifier outside agent-readable paths by content", async () => {
    const verifierDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-verifier-"));
    const verifier = path.join(verifierDir, "verify");
    await fsp.writeFile(verifier, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fsp.chmod(verifier, 0o700);
    try {
      const expected = await normalizeExpectedVerifier(verifier, root, []);
      expect(expected.path).toBe(await fsp.realpath(verifier));
      expect(expected.content_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(await verifierUnchanged(expected)).toBe(true);
      await fsp.appendFile(verifier, "# changed\n");
      expect(await verifierUnchanged(expected)).toBe(false);
      await expect(normalizeExpectedVerifier(
        path.join(root, "src", "app.js"),
        root,
        [],
      )).rejects.toMatchObject({ code: "invalid_eval_answer" });
      await expect(normalizeExpectedVerifier(verifier, root, [verifierDir]))
        .rejects.toMatchObject({ code: "invalid_eval_answer" });
    } finally {
      await fsp.rm(verifierDir, { recursive: true, force: true });
    }
  });
});

async function writeSuite(root, overrides = {}) {
  const document = {
    schema_version: 1,
    suite_id: "code-navigation",
    cases: [{
      id: "locate-target",
      prompt: "Find the implementation.",
      answer_schema: "source-location/v1",
    }],
    ...overrides,
  };
  await fsp.writeFile(
    path.join(root, ".agenthub", "evals.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_PATCH_EVAL_EXECUTION_PROFILE,
  CAPABILITY_PATCH_EVAL_SUITE_SCHEMA_VERSION,
  WORKSPACE_PATCH_SCHEMA,
  WORKSPACE_PATCH_CAPABILITY_GRADER_VERSION,
  WORKSPACE_PATCH_CAPABILITY_VERIFIER_PREFLIGHT,
  WORKSPACE_PATCH_VERIFIER_PREFLIGHT,
  buildEvalPrompt,
  canonicalHash,
  canonicalizeExistingSourceLocation,
  cleanWorkspaceSnapshot,
  gradeSourceLocation,
  loadEvalSuite,
  normalizeExpectedVerifier,
  normalizeExpectedSourceLocation,
  normalizeKnownGoodWorkspace,
  normalizeSuite,
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

  it("loads and snapshots an evaluator-owned suite outside the subject workspace", async () => {
    const evaluatorRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-evaluator-suite-"));
    const suitePath = path.join(evaluatorRoot, "custom.json");
    try {
      await fsp.writeFile(suitePath, `${JSON.stringify({
        schema_version: 1,
        suite_id: "evaluator-owned",
        cases: [{
          id: "locate-target",
          prompt: "Find the evaluator-selected behavior.",
          answer_schema: "source-location/v1",
        }],
      })}\n`);
      const suite = await loadEvalSuite(root, suitePath);
      const pinnedDigest = suite.digest;
      expect(suite.relative_path).toBe(slashPath(path.relative(root, suitePath)));
      expect(suite.cases[0].prompt).toBe("Find the evaluator-selected behavior.");

      await fsp.writeFile(suitePath, "{}\n");
      expect(suite.digest).toBe(pinnedDigest);
      expect(suite.cases[0].prompt).toBe("Find the evaluator-selected behavior.");
    } finally {
      await fsp.rm(evaluatorRoot, { recursive: true, force: true });
    }
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
    expect(first.git_common_dir).toBe(await fsp.realpath(path.join(root, ".git")));
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
      verifier_preflight: WORKSPACE_PATCH_VERIFIER_PREFLIGHT,
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
      }],
    });
    const suite = await loadEvalSuite(root);
    expect(suite).toMatchObject({
      schema_version: 2,
      verifier_preflight: "subject-reject-known-good-pass/v1",
      cases: [{ id: "change-target", answer_schema: "workspace-patch/v1" }],
    });
    expect(buildEvalPrompt(suite.cases[0])).toContain("Implement the requested change");

    const preflightDigest = suite.digest;
    await writeSuite(root, {
      schema_version: 2,
      suite_id: "patch-eval",
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
      }],
    });
    expect((await loadEvalSuite(root)).digest).not.toBe(preflightDigest);

    await writeSuite(root, {
      schema_version: 2,
      suite_id: "patch-eval",
      verifier_preflight: "unknown/v1",
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
      }],
    });
    await expect(loadEvalSuite(root)).rejects.toMatchObject({ code: "invalid_eval_suite" });

    await writeSuite(root, {
      schema_version: 1,
      suite_id: "source-location",
      verifier_preflight: WORKSPACE_PATCH_VERIFIER_PREFLIGHT,
      cases: [{
        id: "locate-target",
        prompt: "Find the target behavior.",
        answer_schema: "source-location/v1",
      }],
    });
    await expect(loadEvalSuite(root)).rejects.toMatchObject({ code: "invalid_eval_suite" });

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

  it("normalizes capability-bound patch suites and command smokes", async () => {
    expect(CAPABILITY_PATCH_EVAL_SUITE_SCHEMA_VERSION).toBe(3);
    expect(CAPABILITY_PATCH_EVAL_EXECUTION_PROFILE).toBe("workspace-write/v2");
    expect(WORKSPACE_PATCH_CAPABILITY_GRADER_VERSION).toBe("workspace-patch/v3");
    expect(WORKSPACE_PATCH_CAPABILITY_VERIFIER_PREFLIGHT)
      .toBe("subject-reject-known-good-pass/v2");

    await writeSuite(root, {
      schema_version: CAPABILITY_PATCH_EVAL_SUITE_SCHEMA_VERSION,
      suite_id: "capability-patch-eval",
      verifier_preflight: WORKSPACE_PATCH_CAPABILITY_VERIFIER_PREFLIGHT,
      toolchain_requirements: {
        kind: "command-smoke/v1",
        commands: [
          { name: "node", argv: ["-e", "process.exit(0)"] },
          { name: "git", argv: ["--version"] },
        ],
      },
      cases: [{
        id: "change-target",
        prompt: "  Change the target behavior.  ",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
      }],
    });
    const suite = await loadEvalSuite(root);
    expect(suite).toMatchObject({
      schema_version: 3,
      verifier_preflight: "subject-reject-known-good-pass/v2",
      toolchain_requirements: {
        kind: "command-smoke/v1",
        commands: [
          { name: "git", argv: ["--version"] },
          { name: "node", argv: ["-e", "process.exit(0)"] },
        ],
      },
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: "workspace-patch/v1",
      }],
    });

    const reordered = normalizeSuite({
      schema_version: 3,
      suite_id: "capability-patch-eval",
      verifier_preflight: WORKSPACE_PATCH_CAPABILITY_VERIFIER_PREFLIGHT,
      toolchain_requirements: {
        kind: "command-smoke/v1",
        commands: [
          { name: "git", argv: ["--version"] },
          { name: "node", argv: ["-e", "process.exit(0)"] },
        ],
      },
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
      }],
    });
    expect(canonicalHash(reordered)).toBe(suite.digest);
  });

  it("rejects incomplete or unsafe capability-bound patch suites", () => {
    const valid = {
      schema_version: CAPABILITY_PATCH_EVAL_SUITE_SCHEMA_VERSION,
      suite_id: "capability-patch-eval",
      verifier_preflight: WORKSPACE_PATCH_CAPABILITY_VERIFIER_PREFLIGHT,
      toolchain_requirements: {
        kind: "command-smoke/v1",
        commands: [{ name: "node", argv: ["--version"] }],
      },
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
      }],
    };
    const rejected = [
      { ...valid, verifier_preflight: undefined },
      { ...valid, verifier_preflight: WORKSPACE_PATCH_VERIFIER_PREFLIGHT },
      { ...valid, toolchain_requirements: undefined },
      { ...valid, toolchain_requirements: { kind: "command-smoke/v2", commands: [] } },
      { ...valid, toolchain_requirements: { kind: "command-smoke/v1", commands: [] } },
      {
        ...valid,
        toolchain_requirements: {
          kind: "command-smoke/v1",
          commands: [{ name: "../node", argv: [] }],
        },
      },
      {
        ...valid,
        toolchain_requirements: {
          kind: "command-smoke/v1",
          commands: [
            { name: "node", argv: [] },
            { name: "node", argv: ["--version"] },
          ],
        },
      },
      {
        ...valid,
        toolchain_requirements: {
          kind: "command-smoke/v1",
          commands: [{ name: "node", argv: ["bad\0argument"] }],
        },
      },
      {
        ...valid,
        toolchain_requirements: {
          kind: "command-smoke/v1",
          commands: [{ name: "node", argv: ["x".repeat(4097)] }],
        },
      },
      {
        ...valid,
        toolchain_requirements: {
          kind: "command-smoke/v1",
          commands: [{ name: "node", argv: Array.from({ length: 65 }, () => "x") }],
        },
      },
      {
        ...valid,
        toolchain_requirements: {
          kind: "command-smoke/v1",
          commands: Array.from({ length: 17 }, (_, index) => ({
            name: `command-${index}`,
            argv: ["x".repeat(4096)],
          })),
        },
      },
      {
        ...valid,
        toolchain_requirements: {
          ...valid.toolchain_requirements,
          extra: true,
        },
      },
      {
        ...valid,
        toolchain_requirements: {
          kind: "command-smoke/v1",
          commands: [{ name: "node", argv: [], extra: true }],
        },
      },
      { ...valid, extra: true },
    ];
    for (const document of rejected) {
      expect(() => normalizeSuite(document)).toThrowError(
        expect.objectContaining({ code: "invalid_eval_suite" }),
      );
    }
  });

  it("preserves the normalized representation and digest of v1 and v2 suites", () => {
    const v1 = normalizeSuite({
      schema_version: 1,
      suite_id: "code-navigation",
      cases: [{
        id: "locate-target",
        prompt: "  Find the implementation.  ",
        answer_schema: "source-location/v1",
      }],
    });
    expect(v1).toEqual({
      schema_version: 1,
      suite_id: "code-navigation",
      cases: [{
        id: "locate-target",
        prompt: "Find the implementation.",
        answer_schema: "source-location/v1",
        question_digest: "2c90c409991f33585c057eda7dc2f0878632f5b713ce028e57d40ff76b634f06",
      }],
    });
    expect(canonicalHash(v1))
      .toBe("acb129efaa869b22287c682246aa96138aab7c5c0d7925b86078e658f84641dd");

    const v2 = normalizeSuite({
      schema_version: 2,
      suite_id: "patch-eval",
      verifier_preflight: WORKSPACE_PATCH_VERIFIER_PREFLIGHT,
      cases: [{
        id: "change-target",
        prompt: "  Change the target behavior.  ",
        answer_schema: WORKSPACE_PATCH_SCHEMA,
      }],
    });
    expect(v2).toEqual({
      schema_version: 2,
      suite_id: "patch-eval",
      verifier_preflight: "subject-reject-known-good-pass/v1",
      cases: [{
        id: "change-target",
        prompt: "Change the target behavior.",
        answer_schema: "workspace-patch/v1",
        question_digest: "98ac7d24b5eea6f947b1ed95a0fb769550506eb78fb5f00d5c1a167d18f06d3d",
      }],
    });
    expect(canonicalHash(v2))
      .toBe("ae7d974a974e14ec68934d2bafc333a1ae24a426c2af35ebaa22c4554d9d6a14");
  });

  it("ships a suite v3 JSON schema matching the runtime contract", async () => {
    const schema = JSON.parse(await fsp.readFile(
      new URL("../schemas/agent-eval-suite-v3.schema.json", import.meta.url),
      "utf8",
    ));
    expect(schema.properties.schema_version.const).toBe(3);
    expect(schema.required).toContain("verifier_preflight");
    expect(schema.required).toContain("toolchain_requirements");
    expect(schema.properties.verifier_preflight.const)
      .toBe(WORKSPACE_PATCH_CAPABILITY_VERIFIER_PREFLIGHT);
    expect(schema.properties.toolchain_requirements.properties.kind.const)
      .toBe("command-smoke/v1");
    expect(schema.properties.cases.items.properties.answer_schema.const)
      .toBe(WORKSPACE_PATCH_SCHEMA);
  });

  it("accepts only a clean descendant worktree as the known-good workspace", async () => {
    const subject = await cleanWorkspaceSnapshot(root);
    const knownGoodRoot = `${root}-known-good`;
    const sameCommitRoot = `${root}-same-commit`;
    const unrelatedCommitRoot = `${root}-unrelated-commit`;
    const otherRepositoryRoot = `${root}-other-repository`;
    const readableRoot = `${root}-runtime-readable`;
    const lexicalControl = path.join(readableRoot, "control-link");
    const linkedWorktrees = [knownGoodRoot, sameCommitRoot, unrelatedCommitRoot];
    try {
      await git(root, "worktree", "add", "--detach", knownGoodRoot, subject.commit);
      await fsp.writeFile(
        path.join(knownGoodRoot, "src", "app.js"),
        "export function target() { return true; }\n",
      );
      await git(knownGoodRoot, "add", ".");
      await git(knownGoodRoot, "commit", "-m", "known good");

      const knownGood = await normalizeKnownGoodWorkspace(knownGoodRoot, subject);
      expect(knownGood).toMatchObject({
        root: await fsp.realpath(knownGoodRoot),
        git_common_dir: subject.git_common_dir,
      });
      expect(knownGood.commit).not.toBe(subject.commit);

      await expect(normalizeKnownGoodWorkspace("relative/path", subject))
        .rejects.toMatchObject({ code: "invalid_eval_answer" });
      await expect(normalizeKnownGoodWorkspace(root, subject))
        .rejects.toMatchObject({ code: "unsafe_eval_oracle" });
      await expect(normalizeKnownGoodWorkspace(knownGoodRoot, subject, [path.dirname(knownGoodRoot)]))
        .rejects.toMatchObject({
          code: "unsafe_eval_oracle",
          message: "Known-good workspace overlaps a workspace or runtime path readable by the agent",
        });
      await expect(normalizeKnownGoodWorkspace(knownGoodRoot, subject, [
        path.join(knownGoodRoot, "src"),
      ])).rejects.toMatchObject({ code: "unsafe_eval_oracle" });
      await fsp.mkdir(readableRoot);
      await fsp.symlink(knownGoodRoot, lexicalControl);
      await expect(normalizeKnownGoodWorkspace(lexicalControl, subject, [readableRoot]))
        .rejects.toMatchObject({ code: "unsafe_eval_oracle" });

      await git(root, "worktree", "add", "--detach", sameCommitRoot, subject.commit);
      await expect(normalizeKnownGoodWorkspace(sameCommitRoot, subject))
        .rejects.toMatchObject({ code: "invalid_eval_answer" });

      const tree = (await git(root, "rev-parse", "HEAD^{tree}")).stdout.trim();
      const unrelatedCommit = (await git(root, "commit-tree", tree, "-m", "unrelated")).stdout.trim();
      await git(root, "worktree", "add", "--detach", unrelatedCommitRoot, unrelatedCommit);
      await expect(normalizeKnownGoodWorkspace(unrelatedCommitRoot, subject))
        .rejects.toMatchObject({
          code: "invalid_eval_answer",
          message: "Known-good workspace commit must descend from the eval subject commit",
        });

      await fsp.mkdir(otherRepositoryRoot);
      await git(otherRepositoryRoot, "init");
      await git(otherRepositoryRoot, "config", "user.email", "test@example.invalid");
      await git(otherRepositoryRoot, "config", "user.name", "Agent Hub Test");
      await fsp.writeFile(path.join(otherRepositoryRoot, "file.txt"), "other\n");
      await git(otherRepositoryRoot, "add", ".");
      await git(otherRepositoryRoot, "commit", "-m", "other");
      await expect(normalizeKnownGoodWorkspace(otherRepositoryRoot, subject))
        .rejects.toMatchObject({
          code: "invalid_eval_answer",
          message: "Known-good workspace must belong to the same Git repository as the eval subject",
        });

      await fsp.appendFile(path.join(knownGoodRoot, "src", "app.js"), "// dirty\n");
      await expect(normalizeKnownGoodWorkspace(knownGoodRoot, subject))
        .rejects.toMatchObject({ code: "invalid_eval_answer" });
    } finally {
      for (const worktree of linkedWorktrees) {
        await git(root, "worktree", "remove", "--force", worktree).catch(() => undefined);
      }
      await Promise.all([
        ...linkedWorktrees.map((target) => fsp.rm(target, { recursive: true, force: true })),
        fsp.rm(otherRepositoryRoot, { recursive: true, force: true }),
        fsp.rm(readableRoot, { recursive: true, force: true }),
      ]);
    }
  }, 30000);

  it("pins an executable verifier outside agent-readable paths by content", async () => {
    const verifierDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-verifier-"));
    const verifier = path.join(verifierDir, "verify");
    const readableDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-runtime-readable-"));
    const lexicalVerifier = path.join(readableDir, "verifier-link");
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
      )).rejects.toMatchObject({ code: "unsafe_eval_oracle" });
      await expect(normalizeExpectedVerifier(verifier, root, [verifierDir]))
        .rejects.toMatchObject({ code: "unsafe_eval_oracle" });
      await fsp.symlink(verifier, lexicalVerifier);
      await expect(normalizeExpectedVerifier(lexicalVerifier, root, [readableDir]))
        .rejects.toMatchObject({ code: "unsafe_eval_oracle" });
    } finally {
      await Promise.all([
        fsp.rm(verifierDir, { recursive: true, force: true }),
        fsp.rm(readableDir, { recursive: true, force: true }),
      ]);
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

function slashPath(value) {
  return value.split(path.sep).join("/");
}

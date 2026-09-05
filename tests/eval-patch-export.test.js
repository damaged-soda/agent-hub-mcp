import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureEvalPatch,
  collectWorkspacePatch,
  finishPatchExport,
  openPatchExport,
  preparePatchExport,
} from "../src/eval-patch-export.js";

const execFileAsync = promisify(execFile);
const runRef = { run_id: "11111111-1111-4111-8111-111111111111" };

describe("Eval patch export", () => {
  let root;

  beforeEach(async () => {
    // Canonicalize macOS's /var and /tmp aliases before testing output identity.
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-patch-export-")));
  });

  afterEach(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  it("does no filesystem work when export was not selected", async () => {
    const output = await preparePatchExport(undefined, [path.join(root, "missing-root")]);
    expect(output).toBeNull();
    await openPatchExport(output);
    await captureEvalPatch(output, { cwd: root, caseId: "unused", runRef });
    await finishPatchExport(output, null);
    expect(await fsp.readdir(root)).toEqual([]);
  });

  it.each(["relative/output", "", ".", null, 42, {}])(
    "rejects a non-absolute output selector: %j",
    async (selector) => {
      await expect(preparePatchExport(selector, [])).rejects.toMatchObject({
        code: "invalid_patch_output",
      });
      expect(await fsp.readdir(root)).toEqual([]);
    },
  );

  it("defers creation until open and accepts a sibling whose name shares a forbidden prefix", async () => {
    const forbidden = path.join(root, "subject");
    const alias = path.join(root, "parent-alias");
    const directory = path.join(root, "subject-patches");
    await fsp.mkdir(forbidden);
    await fsp.symlink(root, alias);
    const output = await preparePatchExport(path.join(alias, "subject-patches"), [forbidden]);

    await expect(fsp.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await openPatchExport(output);
    expect(output.directory).toBe(directory);
    expect((await fsp.lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await fsp.readdir(directory)).toEqual([]);
  });

  it.each(["directory", "file", "symlink", "dangling-symlink"])(
    "rejects an already existing output %s without altering it",
    async (kind) => {
      const directory = path.join(root, "output");
      const target = path.join(root, "target");
      if (kind === "directory") await fsp.mkdir(directory);
      else if (kind === "file") await fsp.writeFile(directory, "keep me");
      else {
        if (kind === "symlink") await fsp.mkdir(target);
        await fsp.symlink(target, directory);
      }
      const before = await readTree(root);
      await expect(preparePatchExport(directory, [])).rejects.toMatchObject({
        code: "invalid_patch_output",
      });
      expect(await readTree(root)).toEqual(before);
      expect((await fsp.lstat(directory)).isSymbolicLink()).toBe(kind.includes("symlink"));
    },
  );

  it("rejects lexical overlap with every forbidden capability, including normalized dot segments", async () => {
    const forbidden = ["subject", "git-common", "runtime", "toolchain"]
      .map((name) => path.join(root, name));
    for (const directory of forbidden) await fsp.mkdir(directory);
    for (const directory of forbidden) {
      for (const selector of [directory, path.join(directory, "export"), `${root}/unused/../${path.basename(directory)}/export`]) {
        await expect(preparePatchExport(selector, forbidden)).rejects.toMatchObject({
          code: "invalid_patch_output",
          message: expect.stringMatching(/overlap/i),
        });
      }
      expect(await fsp.readdir(directory)).toEqual([]);
    }
    // An output must not be an ancestor of a capability either.
    await expect(preparePatchExport(root, forbidden)).rejects.toMatchObject({
      code: "invalid_patch_output",
      message: expect.stringMatching(/overlap/i),
    });
  });

  it("treats the filesystem root as overlapping every absolute output", async () => {
    await expect(preparePatchExport(path.join(root, "export"), [path.parse(root).root]))
      .rejects.toMatchObject({ code: "invalid_patch_output" });
  });

  it("rejects output reached indirectly through a symlink into a forbidden root", async () => {
    const forbidden = path.join(root, "private-capability");
    const alias = path.join(root, "innocent-alias");
    await fsp.mkdir(forbidden);
    await fsp.symlink(forbidden, alias);
    await expect(preparePatchExport(path.join(alias, "export"), [forbidden]))
      .rejects.toMatchObject({ code: "invalid_patch_output" });
    expect(await fsp.readdir(forbidden)).toEqual([]);
  });

  it("resolves symlinks in forbidden roots as well as the output selector", async () => {
    const realRoot = path.join(root, "real-capability");
    const alias = path.join(root, "capability-alias");
    await fsp.mkdir(realRoot);
    await fsp.symlink(realRoot, alias);
    await expect(preparePatchExport(path.join(realRoot, "export"), [alias]))
      .rejects.toMatchObject({ code: "invalid_patch_output" });
    expect(await fsp.readdir(realRoot)).toEqual([]);
  });

  it("rejects lexical containment even when a symlink redirects the output outside the forbidden root", async () => {
    const forbidden = path.join(root, "subject");
    const outside = path.join(root, "outside");
    await fsp.mkdir(forbidden);
    await fsp.mkdir(outside);
    await fsp.symlink(outside, path.join(forbidden, "escape"));
    await expect(preparePatchExport(path.join(forbidden, "escape", "export"), [forbidden]))
      .rejects.toMatchObject({ code: "invalid_patch_output" });
    expect(await fsp.readdir(outside)).toEqual([]);
  });

  it("does not reuse a directory created between prepare and open", async () => {
    const directory = path.join(root, "output");
    const output = await preparePatchExport(directory, []);
    await fsp.mkdir(directory);
    await fsp.writeFile(path.join(directory, "sentinel"), "do not overwrite");
    const before = await readTree(directory);
    await expect(openPatchExport(output)).rejects.toThrow();
    expect(await readTree(directory)).toEqual(before);
  });

  it("rejects a parent replaced with a symlink after prepare, before creating any export", async () => {
    const parent = path.join(root, "parent");
    const forbidden = path.join(root, "subject");
    await fsp.mkdir(parent);
    await fsp.mkdir(forbidden);
    await fsp.writeFile(path.join(forbidden, "sentinel"), "keep me\n");
    const output = await preparePatchExport(path.join(parent, "export"), [forbidden]);
    const savedParent = path.join(root, "saved-parent");
    await fsp.rename(parent, savedParent);
    await fsp.symlink(forbidden, parent);
    const before = await readTree(forbidden);

    await expect(openPatchExport(output)).rejects.toMatchObject({ code: "invalid_patch_output" });

    expect(await readTree(forbidden)).toEqual(before);
    expect(await fsp.readdir(savedParent)).toEqual([]);
    await expect(fsp.lstat(path.join(forbidden, "export"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips tracked edits, deletions, both mode changes and staged/unstaged renames without changing Git state", async () => {
    const baseline = {
      ".gitignore": "build/\ndist/\n*.o\n",
      "src/edit.txt": "original\n",
      "src/delete.txt": "delete this\n",
      "src/staged rename.txt": "staged rename contents\n",
      "src/loose rename.txt": "unstaged rename contents\n",
      "src/binary.dat": Buffer.from([0, 0xff, 0x80, 1, 2, 3]),
      "bin/enable.sh": { content: "#!/bin/sh\nexit 0\n", mode: 0o644 },
      "bin/disable.sh": { content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
      "current-link": { link: "src/edit.txt" },
      "build/tracked.txt": "tracked files are exported even under ignored directories\n",
    };
    const source = await createRepository(path.join(root, "source"), baseline);
    const target = await createRepository(path.join(root, "target"), baseline);
    await fsp.writeFile(path.join(source, "src/edit.txt"), "staged edit\n");
    await git(source, ["add", "--", "src/edit.txt"]);
    await fsp.appendFile(path.join(source, "src/edit.txt"), "also unstaged\n");
    await git(source, ["rm", "--", "src/delete.txt"]);
    await git(source, ["mv", "--", "src/staged rename.txt", "src/renamed\nstaged.txt"]);
    await fsp.rename(path.join(source, "src/loose rename.txt"), path.join(source, "src/renamed loose.txt"));
    await fsp.chmod(path.join(source, "bin/enable.sh"), 0o755);
    await fsp.chmod(path.join(source, "bin/disable.sh"), 0o644);
    await fsp.writeFile(path.join(source, "src/binary.dat"), Buffer.from([0, 0xfe, 0x81, 4, 5, 6]));
    await fsp.unlink(path.join(source, "current-link"));
    await fsp.symlink("src/renamed loose.txt", path.join(source, "current-link"));
    await fsp.writeFile(path.join(source, "build/tracked.txt"), "changed tracked build input\n");
    // Newly staged files remain part of the patch even when the ignore rules match them.
    await fsp.writeFile(path.join(source, "build/forced-source.txt"), "force-added source must survive\n");
    await git(source, ["add", "--force", "--", "build/forced-source.txt"]);
    await fsp.writeFile(path.join(source, "intent-to-add.txt"), "intent only\n");
    await git(source, ["add", "--intent-to-add", "--", "intent-to-add.txt"]);
    const stateBefore = await gitState(source);
    const expected = await readTree(source);
    const output = await preparePatchExport(path.join(root, "export"), [source, target]);
    await openPatchExport(output);

    await captureEvalPatch(output, { cwd: source, caseId: "tracked", runRef, patchDigest: "d".repeat(64) });

    expect(await gitState(source)).toEqual(stateBefore);
    expect(await readTree(source)).toEqual(expected);
    await finishPatchExport(output, resultFor(await head(source), [gradedCase("tracked")]));
    const manifest = await readManifest(output);
    await applyPatch(target, path.join(output.directory, manifest.patches[0].file));
    expect(await readTree(target)).toEqual(expected);
  }, 20000);

  it("round-trips untracked bytes, empty files, symlinks and whitespace names while omitting ignored build output", async () => {
    const baseline = { ".gitignore": "build/\ndist/\n*.o\n", "tracked.txt": "unchanged\n" };
    const source = await createRepository(path.join(root, "source"), baseline);
    const target = await createRepository(path.join(root, "target"), baseline);
    const additions = {
      "plain.txt": "new text without a final newline",
      "empty.txt": "",
      "binary.dat": Buffer.from([0, 0xff, 0xfe, 0x80, 0x0a, 1]),
      // No NUL: Git may emit this as a textual hunk, which must still retain raw bytes.
      "non-utf8.txt": Buffer.from([0xff, 0xfe, 0x80, 0x61, 0x0a]),
      "white space dir/ leading and trailing .txt ": "spaces\n",
      "white space dir/tab\tand\nnewline.txt": "tabs and newlines\n",
      'quote"and\\backslash.txt': "quoted path\n",
      "-option-like.txt": "not a Git option\n",
      "new-script.sh": { content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
      "relative link": { link: "white space dir/tab\tand\nnewline.txt" },
      "dangling-link": { link: "missing target" },
    };
    await writeEntries(source, additions);
    const expected = await readTree(source);
    await writeEntries(source, {
      "build/generated.js": "ignored build sentinel\n",
      "dist/bundle.bin": Buffer.from([0, 0xee, 0xff]),
      "temporary.o": "ignored object sentinel\n",
    });
    const before = await gitState(source);

    const patch = await collectWorkspacePatch(source);

    expect(Buffer.isBuffer(patch)).toBe(true);
    expect(await gitState(source)).toEqual(before);
    const patchFile = path.join(root, "untracked.patch");
    await fsp.writeFile(patchFile, patch);
    await applyPatch(target, patchFile);
    expect(await readTree(target)).toEqual(expected);
    expect(await fsp.readFile(path.join(source, "build/generated.js"), "utf8"))
      .toBe("ignored build sentinel\n");
  }, 20000);

  it("returns an empty Buffer for a clean workspace, including ignored files", async () => {
    const source = await createRepository(path.join(root, "source"), { ".gitignore": "build/\n" });
    await writeEntries(source, { "build/output": "ignored\n" });
    const before = await gitState(source);
    expect(await collectWorkspacePatch(source)).toEqual(Buffer.alloc(0));
    expect(await gitState(source)).toEqual(before);
  });

  it("binds each patch's bytes, case, run and grade in a private manifest without oracle/control or absolute paths", async () => {
    const source = await createRepository(path.join(root, "source"), { "answer.txt": "original\n" });
    const output = await preparePatchExport(path.join(root, "export"), [source]);
    await openPatchExport(output);
    const otherRunRef = { run_id: "22222222-2222-4222-8222-222222222222" };
    const captures = [
      { caseId: "case-b", runRef, patchDigest: "b".repeat(64), content: "first answer\n" },
      { caseId: "case-a", runRef: otherRunRef, content: "second answer\n" },
    ];
    for (const capture of captures) {
      await fsp.writeFile(path.join(source, "answer.txt"), capture.content);
      await captureEvalPatch(output, { cwd: source, ...capture });
    }
    const exportedBeforeVerifier = await readTree(output.directory);
    await expect(fsp.lstat(path.join(output.directory, "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await writeEntries(source, { "answer.txt": "verifier changed the answer\n", "hidden-test.txt": "ORACLE-CONTENT-SENTINEL\n" });
    const result = resultFor(await head(source), [
      {
        ...gradedCase("case-a", "fail", "verifier_failed"),
        agent_run_ref: otherRunRef,
        verifier_output: "ORACLE-OUTPUT-SENTINEL",
      },
      { ...gradedCase("case-b"), control: { commit: "c".repeat(40), path: path.join(root, "known-good") } },
      gradedCase("not-captured", "error", "agent_error"),
    ]);
    Object.assign(result, {
      oracle: { contents: "ORACLE-CONTENT-SENTINEL", path: path.join(root, "oracle.sh") },
      control: { contents: "CONTROL-CONTENT-SENTINEL", commit: "c".repeat(40) },
      artifact: { path: path.join(root, "eval-result.json") },
    });
    result.subject.cwd = source;
    result.suite.path = path.join(root, "private-suite.json");
    result.suite.prompt = "QUESTION-SENTINEL";

    await finishPatchExport(output, result);

    const manifest = await readManifest(output);
    const expectedRecords = [];
    for (const capture of captures) {
      const record = manifest.patches.find((item) => item.case_id === capture.caseId);
      expect(record).toBeDefined();
      expect(path.isAbsolute(record.file)).toBe(false);
      expect(path.basename(record.file)).toBe(record.file);
      expect(record.file).toMatch(/\.patch$/);
      const patchFile = path.join(output.directory, record.file);
      const bytes = await fsp.readFile(patchFile);
      expect(bytes).toEqual(exportedBeforeVerifier[record.file].content);
      expect(bytes.includes(Buffer.from(capture.content))).toBe(true);
      expect(bytes.includes(Buffer.from("ORACLE-CONTENT-SENTINEL"))).toBe(false);
      expect((await fsp.stat(patchFile)).mode & 0o777).toBe(0o600);
      const grade = result.cases.find((item) => item.case_id === capture.caseId);
      expectedRecords.push({
        case_id: capture.caseId,
        agent_run_ref: capture.runRef,
        file: record.file,
        content_digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
        bytes: bytes.length,
        metrics_patch_digest: capture.patchDigest ?? null,
        status: grade.status,
        reason: grade.reason,
      });
    }
    expect(manifest).toEqual({
      kind: "agent-eval-patch-export/v1",
      eval_run_id: result.eval_run_id,
      subject_commit: result.subject.commit,
      suite_digest: result.suite.suite_digest,
      capture_phase: "after-agent-before-verifier",
      patches: expectedRecords,
    });
    expect(new Set(manifest.patches.map((item) => item.file)).size).toBe(2);
    expect((await fsp.stat(path.join(output.directory, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await fsp.readdir(output.directory)).sort()).toEqual([
      "manifest.json", ...manifest.patches.map((item) => item.file),
    ].sort());
    for (const value of stringValues(manifest)) expect(path.isAbsolute(value)).toBe(false);
    const serialized = JSON.stringify(manifest);
    for (const secret of [root, "ORACLE-", "CONTROL-", "QUESTION-SENTINEL", "c".repeat(40)]) {
      expect(serialized).not.toContain(secret);
    }
    const manifestBytes = await fsp.readFile(path.join(output.directory, "manifest.json"));
    await expect(finishPatchExport(output, result)).rejects.toThrow();
    expect(await fsp.readFile(path.join(output.directory, "manifest.json"))).toEqual(manifestBytes);
  }, 15000);

  it.each([
    ["capture", "symlink"], ["finish", "symlink"],
    ["capture", "directory"], ["finish", "directory"],
  ])("fails %s if the opened output is replaced with a different %s", async (operation, replacement) => {
    const source = await createRepository(path.join(root, "source"), { "answer.txt": "before\n" });
    await fsp.writeFile(path.join(source, "answer.txt"), "after\n");
    const directory = path.join(root, "output");
    const output = await preparePatchExport(directory, [source]);
    await openPatchExport(output);
    await captureEvalPatch(output, { cwd: source, caseId: "case-a", runRef });
    const saved = path.join(root, "original-output");
    await fsp.rename(directory, saved);
    const redirected = replacement === "symlink" ? path.join(root, "redirected") : directory;
    await fsp.mkdir(redirected);
    await fsp.writeFile(path.join(redirected, "sentinel"), "keep me\n");
    if (replacement === "symlink") await fsp.symlink(redirected, directory);
    const originalBefore = await readTree(saved);
    const redirectedBefore = await readTree(redirected);

    const action = operation === "capture"
      ? captureEvalPatch(output, { cwd: source, caseId: "case-b", runRef })
      : finishPatchExport(output, resultFor(await head(source), [gradedCase("case-a")]));
    await expect(action).rejects.toMatchObject({ code: "patch_export_failed" });

    expect(await readTree(saved)).toEqual(originalBefore);
    expect(await readTree(redirected)).toEqual(redirectedBefore);
  }, 10000);

  it("fails capture without creating a partial patch when Git cannot inspect the workspace", async () => {
    const output = await preparePatchExport(path.join(root, "output"), []);
    await openPatchExport(output);
    await expect(captureEvalPatch(output, { cwd: path.join(root, "not-a-repository"), caseId: "case-a", runRef }))
      .rejects.toMatchObject({ code: "patch_export_failed" });
    expect(await fsp.readdir(output.directory)).toEqual([]);
  });

  it("rejects a Git submodule entry without leaving a partial export or changing the index", async () => {
    const source = await createRepository(path.join(root, "source"), { "tracked.txt": "baseline\n" });
    // A real gitlink, using an existing fixture commit; no network or external repository needed.
    await git(source, ["update-index", "--add", "--cacheinfo", `160000,${await head(source)},vendor/library`]);
    const before = await gitState(source);
    const output = await preparePatchExport(path.join(root, "output"), [source]);
    await openPatchExport(output);

    await expect(captureEvalPatch(output, { cwd: source, caseId: "submodule", runRef }))
      .rejects.toMatchObject({ code: "patch_export_failed", message: expect.stringMatching(/submodule/i) });

    expect(await fsp.readdir(output.directory)).toEqual([]);
    expect(await gitState(source)).toEqual(before);
  }, 10000);

  it("accepts 1000 combined tracked/untracked changes and rejects the 1001st without a partial artifact", async () => {
    const baseline = Object.fromEntries(Array.from({ length: 999 }, (_, index) => [
      `tracked/file-${index}.txt`, "before\n",
    ]));
    const source = await createRepository(path.join(root, "source"), baseline);
    await writeEntries(source, Object.fromEntries(Object.keys(baseline).map((name) => [name, "after\n"])));
    await fsp.writeFile(path.join(source, "untracked-1000.txt"), "included\n");
    const output = await preparePatchExport(path.join(root, "output"), [source]);
    await openPatchExport(output);
    await captureEvalPatch(output, { cwd: source, caseId: "within-limit", runRef });
    const successfulExport = await readTree(output.directory);
    expect(Object.keys(successfulExport)).toHaveLength(1);
    expect(Object.values(successfulExport)[0].content.includes(Buffer.from("untracked-1000.txt"))).toBe(true);
    await fsp.writeFile(path.join(source, "untracked-1001.txt"), "over the limit\n");
    const before = await gitState(source);

    await expect(captureEvalPatch(output, { cwd: source, caseId: "over-limit", runRef }))
      .rejects.toMatchObject({ code: "patch_export_failed", message: expect.stringMatching(/too many files/i) });

    expect(await readTree(output.directory)).toEqual(successfulExport);
    expect(await gitState(source)).toEqual(before);
    await finishPatchExport(output, resultFor(await head(source), [gradedCase("within-limit")]));
    expect((await readManifest(output)).patches.map((record) => record.case_id)).toEqual(["within-limit"]);
  }, 20000);

  it("does not invoke repository clean filters while exporting raw tracked bytes", async () => {
    const baseline = {
      ".gitattributes": "*.filtered filter=export-probe\n",
      "answer.filtered": "original\n",
    };
    const source = await createRepository(path.join(root, "source"), baseline);
    const target = await createRepository(path.join(root, "target"), baseline);
    // A harmless marker makes executing the filter observable even if its output is discarded.
    await git(source, ["config", "filter.export-probe.clean", "printf invoked > ../clean-filter-ran && cat"]);
    await fsp.writeFile(path.join(source, "answer.filtered"), "raw agent bytes\n");

    const patch = await collectWorkspacePatch(source);

    await expect(fsp.lstat(path.join(root, "clean-filter-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    const patchFile = path.join(root, "filtered.patch");
    await fsp.writeFile(patchFile, patch);
    await applyPatch(target, patchFile);
    expect(await fsp.readFile(path.join(target, "answer.filtered"), "utf8")).toBe("raw agent bytes\n");
  }, 10000);

  it("preserves submitted tracked/untracked bytes despite text, EOL and working-tree encoding attributes", async () => {
    const baseline = {
      ".gitattributes": "*.txt text\n*.crlf text eol=crlf\n*.utf16 text working-tree-encoding=UTF-16LE eol=crlf\n",
      "tracked.txt": "before\n",
      "tracked.crlf": "before\r\n",
      "tracked.utf16": Buffer.from("before\r\n", "utf16le"),
    };
    const source = await createRepository(path.join(root, "source"), baseline);
    const target = await createRepository(path.join(root, "target"), baseline);
    // Prove that the fixture's attributes really normalize CRLF and transcode UTF-16LE on add.
    for (const name of ["tracked.txt", "tracked.crlf", "tracked.utf16"]) {
      expect(await git(source, ["show", `HEAD:${name}`])).toEqual(Buffer.from("before\n"));
    }
    const submitted = {
      "tracked.txt": Buffer.from("agent text\r\nkeep CRLF\r\n"),
      "tracked.crlf": Buffer.from("agent CRLF\r\nsecond line\r\n"),
      "tracked.utf16": Buffer.from("agent 编码 Ω\r\n", "utf16le"),
      "new.txt": Buffer.from("new text\r\n"),
      "new.crlf": Buffer.from("new CRLF\r\n"),
      "new.utf16": Buffer.from("new 编码 Ω\r\n", "utf16le"),
    };
    await writeEntries(source, submitted);
    const before = await gitState(source);
    const expectedTree = await readTree(source);

    const patch = await collectWorkspacePatch(source);

    expect(await gitState(source)).toEqual(before);
    expect(await readTree(source)).toEqual(expectedTree);
    const patchFile = path.join(root, "attributes.patch");
    await fsp.writeFile(patchFile, patch);
    // Apply to committed blobs so the receiving checkout cannot transform the bytes a second time.
    await git(target, ["apply", "--check", "--cached", "--binary", patchFile]);
    await git(target, ["apply", "--cached", "--binary", patchFile]);
    for (const [name, bytes] of Object.entries(submitted)) {
      expect(await git(target, ["show", `:${name}`])).toEqual(bytes);
    }
    expect(await git(target, ["show", ":.gitattributes"]))
      .toEqual(Buffer.from(baseline[".gitattributes"]));
  }, 15000);
});

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10000,
  });
  return stdout;
}

async function createRepository(cwd, entries = {}) {
  await fsp.mkdir(cwd);
  await git(cwd, ["init", "--quiet", "--template=", "--initial-branch=main"]);
  for (const [key, value] of [
    ["core.fileMode", "true"], ["core.symlinks", "true"], ["core.autocrlf", "false"],
    ["core.hooksPath", path.join(cwd, ".git", "empty-hooks")], ["commit.gpgSign", "false"],
  ]) await git(cwd, ["config", "--local", key, value]);
  await writeEntries(cwd, entries);
  await git(cwd, ["add", "--all", "--force"]);
  await git(cwd, ["-c", "user.name=Patch Export Test", "-c", "user.email=patch-export@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "fixture baseline"]);
  return cwd;
}

async function writeEntries(cwd, entries) {
  for (const [name, value] of Object.entries(entries)) {
    const filename = path.join(cwd, name);
    await fsp.mkdir(path.dirname(filename), { recursive: true });
    if (value && Object.hasOwn(value, "link")) {
      await fsp.symlink(value.link, filename);
    } else {
      const content = value && Object.hasOwn(value, "content") ? value.content : value;
      await fsp.writeFile(filename, content);
      await fsp.chmod(filename, value?.mode ?? 0o644);
    }
  }
}

// Compare the resulting filesystem, not Git's choice of hunk or rename formatting.
async function readTree(cwd) {
  const entries = {};
  async function visit(relative) {
    for (const name of (await fsp.readdir(path.join(cwd, relative))).sort()) {
      if (!relative && name === ".git") continue;
      const child = path.join(relative, name);
      const filename = path.join(cwd, child);
      const stat = await fsp.lstat(filename);
      if (stat.isSymbolicLink()) entries[child] = { link: await fsp.readlink(filename) };
      else if (stat.isDirectory()) await visit(child);
      else entries[child] = { content: await fsp.readFile(filename), mode: stat.mode & 0o777 };
    }
  }
  await visit("");
  return entries;
}

async function gitState(cwd) {
  return {
    head: await head(cwd),
    status: await git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    staged: await git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
    unstaged: await git(cwd, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"]),
    index: await fsp.readFile(path.join(cwd, ".git", "index")),
  };
}

async function head(cwd) {
  return (await git(cwd, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

async function applyPatch(cwd, filename) {
  await git(cwd, ["apply", "--check", "--binary", "--index", filename]);
  await git(cwd, ["apply", "--binary", "--index", filename]);
}

function gradedCase(caseId, status = "pass", reason = "verifier_passed") {
  return { case_id: caseId, agent_run_ref: runRef, status, reason };
}

function resultFor(commit, cases) {
  return {
    eval_run_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    subject: { commit },
    suite: { suite_digest: "a".repeat(64) },
    cases,
  };
}

async function readManifest(output) {
  return JSON.parse(await fsp.readFile(path.join(output.directory, "manifest.json"), "utf8"));
}

function* stringValues(value) {
  if (typeof value === "string") yield value;
  else if (value && typeof value === "object") {
    for (const child of Object.values(value)) yield* stringValues(child);
  }
}

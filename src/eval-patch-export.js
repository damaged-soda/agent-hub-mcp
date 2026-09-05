import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { evalError } from "./eval-protocol.js";

const execFileAsync = promisify(execFile);
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1000;

// Evaluator-owned output: never add this path to a child capability or result.
export async function preparePatchExport(selector, forbiddenRoots) {
  if (selector === undefined) return null;
  if (typeof selector !== "string" || !path.isAbsolute(selector)) {
    throw evalError("invalid_patch_output", "--patch-output requires a new absolute directory");
  }
  const lexical = path.resolve(selector);
  const parent = await fsp.realpath(path.dirname(lexical));
  const directory = path.join(parent, path.basename(lexical));
  for (const root of forbiddenRoots.filter(Boolean)) {
    const realRoot = await fsp.realpath(root);
    if ([lexical, directory].some((output) =>
      [path.resolve(root), realRoot].some((denied) => overlaps(output, denied)))) {
      throw evalError("invalid_patch_output", "Patch output overlaps an evaluated or runtime capability");
    }
  }
  if (await fsp.lstat(directory).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) {
    throw evalError("invalid_patch_output", "Patch output directory must not already exist");
  }
  return { directory, records: [], identity: null };
}

export async function openPatchExport(output) {
  if (!output) return;
  if (await fsp.realpath(path.dirname(output.directory)) !== path.dirname(output.directory)) {
    throw evalError("invalid_patch_output", "Patch output parent changed during preflight");
  }
  // No recursive mkdir or reuse: a preflight failure leaves no export artifact.
  await fsp.mkdir(output.directory, { mode: 0o700 });
  output.identity = await fsp.lstat(output.directory);
}

export async function captureEvalPatch(output, { cwd, caseId, runRef, patchDigest }) {
  if (!output) return;
  await assertOutput(output);
  const patch = await collectWorkspacePatch(cwd);
  const filename = `${crypto.randomUUID()}.patch`;
  await fsp.writeFile(path.join(output.directory, filename), patch, { flag: "wx", mode: 0o600 });
  const record = {
    case_id: caseId,
    agent_run_ref: runRef,
    file: filename,
    content_digest: `sha256:${crypto.createHash("sha256").update(patch).digest("hex")}`,
    bytes: patch.length,
    metrics_patch_digest: patchDigest ?? null,
  };
  output.records.push(record);
  return record;
}

export async function finishPatchExport(output, result) {
  if (!output) return;
  await assertOutput(output);
  const manifest = {
    kind: "agent-eval-patch-export/v1",
    eval_run_id: result.eval_run_id,
    subject_commit: result.subject.commit,
    suite_digest: result.suite.suite_digest,
    capture_phase: "after-agent-before-verifier",
    patches: output.records.map((record) => {
      const graded = result.cases.find((item) => item.case_id === record.case_id);
      return { ...record, status: graded.status, reason: graded.reason };
    }),
  };
  await fsp.writeFile(path.join(output.directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

// Preserve byte content, modes, symlinks, deletions, and untracked additions without
// staging or executing Git clean filters. Ignored build output is not part of a patch.
export async function collectWorkspacePatch(cwd) {
  // A private index/config plus an empty attributes tree prevents host clean filters,
  // text encodings, and EOL rules from executing or rewriting submitted bytes.
  const currentIndex = await gitBytes(cwd, ["ls-files", "--stage", "-z"]);
  if (currentIndex.toString("utf8").split("\0").some((entry) => entry.startsWith("160000 "))) {
    throw evalError("patch_export_failed", "Submodule repositories are not supported by patch export");
  }
  const subject = (await gitBytes(cwd, ["rev-parse", "HEAD"])).toString("utf8").trim();
  const objects = path.resolve(cwd, (await gitBytes(cwd, ["rev-parse", "--git-path", "objects"]))
    .toString("utf8").trim());
  const format = (await gitBytes(cwd, ["rev-parse", "--show-object-format"]))
    .toString("utf8").trim();
  const visible = new Set(decodePaths(await gitBytes(cwd,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])));
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-patch-capture-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects),
  });
  try {
    await gitBytes(scratch, ["init", "--bare", "--quiet", "--template=", `--object-format=${format}`, scratch], [0], env);
    const args = ["--git-dir", scratch, "--work-tree", cwd, "-c", "core.bare=false",
      "-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false"];
    const emptyTree = (await gitBytes(scratch, [...args, "hash-object", "-t", "tree", "-w", "--stdin"], [0], env))
      .toString("utf8").trim();
    args.push(`--attr-source=${emptyTree}`);
    const git = (tail, accepted = [0]) => gitBytes(scratch, [...args, ...tail], accepted, env);
    await git(["read-tree", subject]);
    const index = await git(["ls-files", "--stage", "-z"]);
    if (index.toString("utf8").split("\0").some((entry) => entry.startsWith("160000 "))) {
      throw evalError("patch_export_failed", "Submodule repositories are not supported by patch export");
    }
    const common = ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--src-prefix=a/", "--dst-prefix=b/"];
    const chunks = [await git([...common, subject, "--"])];
    const baselineFiles = new Set(decodePaths(await git(["ls-files", "--cached", "-z"])));
    const names = [];
    for (const name of visible) {
      if (baselineFiles.has(name)) continue;
      const exists = await fsp.lstat(path.join(cwd, name)).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists) names.push(name);
    }
    const changed = decodePaths(await git(["diff", "--name-only", "-z", "--no-renames", subject, "--"]));
    if (changed.length + names.length > MAX_FILES) {
      throw evalError("patch_export_failed", "Patch changes too many files");
    }
    let bytes = chunks[0].length;
    for (const name of names) {
      const stat = await fsp.lstat(path.join(cwd, name));
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw evalError("patch_export_failed", "Patch contains an unsupported file type");
      }
      // Run no-index with cwd=workspace for stable, repository-relative headers.
      // It still uses the private Git metadata and empty attribute source.
      const relativeChunk = await gitBytes(cwd, [...args, ...common, "--no-index", "--", "/dev/null", name], [0, 1], env);
      bytes += relativeChunk.length;
      if (bytes > MAX_BYTES) throw evalError("patch_export_failed", "Patch exceeds export byte limit");
      chunks.push(relativeChunk);
    }
    return Buffer.concat(chunks);
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

function decodePaths(buffer) {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer).split("\0").filter(Boolean);
}

async function gitBytes(cwd, args, accepted = [0], env = process.env) {
  try {
    const pending = execFileAsync("git", args, {
      cwd, env, encoding: "buffer", maxBuffer: MAX_BYTES, timeout: 30000,
    });
    pending.child.stdin.end();
    const result = await pending;
    return result.stdout;
  } catch (error) {
    if (accepted.includes(error.code) && !error.killed) return error.stdout;
    throw evalError("patch_export_failed", "Could not capture the complete workspace patch");
  }
}

async function assertOutput(output) {
  const current = await fsp.lstat(output.directory);
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== output.identity?.dev || current.ino !== output.identity?.ino ||
      await fsp.realpath(output.directory) !== output.directory) {
    throw evalError("patch_export_failed", "Patch output directory changed");
  }
}

function overlaps(left, right) {
  const within = (candidate, root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
      !relative.startsWith(`..${path.sep}`));
  };
  return within(left, right) || within(right, left);
}

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import { promisify } from "node:util";
import {
  MATERIAL_BUNDLE_MAX_BYTES,
  MATERIAL_ITEM_MAX_BYTES,
} from "./discussion-protocol.js";
import {
  discussionDirFor,
  readDiscussionArtifact,
  writeDiscussionArtifact,
} from "./discussion-store.js";
import { validateRegularFile } from "./security.js";

const execFileAsync = promisify(execFile);

export async function freezeMaterials(discussionId, cwd, materials) {
  const items = [];
  let totalBytes = 0;
  for (const material of materials) {
    const loaded =
      material.type === "inline"
        ? { buffer: Buffer.from(material.content, "utf8"), real_path: undefined }
        : await readValidatedFile(material.path, `materials.${material.material_id}`, cwd);
    const buffer = loaded.buffer;
    if (buffer.length > MATERIAL_ITEM_MAX_BYTES) {
      throw codedError(
        "material_too_large",
        `${material.material_id} exceeds ${MATERIAL_ITEM_MAX_BYTES} bytes`,
      );
    }
    if (buffer.includes(0)) {
      throw codedError("material_not_text", `${material.material_id} contains NUL bytes`);
    }
    assertUtf8(buffer, material.material_id);
    totalBytes += buffer.length;
    if (totalBytes > MATERIAL_BUNDLE_MAX_BYTES) {
      throw codedError(
        "material_bundle_too_large",
        `Material bundle exceeds ${MATERIAL_BUNDLE_MAX_BYTES} bytes`,
      );
    }
    const relativePath = `materials/items/${material.material_id}.txt`;
    await writeDiscussionArtifact(discussionId, relativePath, buffer);
    items.push({
      material_id: material.material_id,
      type: material.type,
      title: material.title,
      source_path: loaded.real_path,
      stored_path: relativePath,
      bytes: buffer.length,
      sha256: sha256(buffer),
    });
  }
  const manifest = {
    schema_version: 1,
    frozen_at: new Date().toISOString(),
    total_bytes: totalBytes,
    items,
    workspace: await workspaceProvenance(cwd),
  };
  await writeDiscussionArtifact(discussionId, "materials/manifest.json", manifest);
  return manifest;
}

export async function loadMaterialContext(discussionId, manifest) {
  const result = [];
  for (const item of manifest.items) {
    const content = await readDiscussionArtifact(discussionId, item.stored_path);
    if (content === null) {
      throw codedError("material_missing", `Missing frozen material ${item.material_id}`);
    }
    if (sha256(Buffer.from(content, "utf8")) !== item.sha256) {
      throw codedError("material_hash_mismatch", `Frozen material changed: ${item.material_id}`);
    }
    result.push({ ...item, content });
  }
  return { manifest, items: result };
}

export async function freezeHandoff(discussionId, handoff) {
  await writeDiscussionArtifact(discussionId, "handoff/context.json", handoff);
  return handoff;
}

async function readValidatedFile(target, label, cwd) {
  const real = await validateRegularFile(target, label, cwd);
  const handle = await fsp.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw codedError("material_not_file", `${label} must remain a regular file`);
    }
    if (stat.size > MATERIAL_ITEM_MAX_BYTES) {
      throw codedError("material_too_large", `${label} exceeds ${MATERIAL_ITEM_MAX_BYTES} bytes`);
    }
    return { buffer: await handle.readFile(), real_path: real };
  } finally {
    await handle.close();
  }
}

function assertUtf8(buffer, label) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw codedError("material_not_text", `${label} is not valid UTF-8 text`);
  }
}

async function workspaceProvenance(cwd) {
  try {
    const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.trim() !== "true") return null;
    const [head, branch, status, diff] = await Promise.all([
      git(cwd, ["rev-parse", "HEAD"]),
      git(cwd, ["branch", "--show-current"]),
      git(cwd, ["status", "--porcelain=v1"]),
      git(cwd, ["diff", "--no-ext-diff", "HEAD"]),
    ]);
    return {
      git_head: head.trim(),
      git_branch: branch.trim() || null,
      git_status_porcelain: status.trimEnd(),
      tracked_dirty_diff_sha256: sha256(Buffer.from(diff, "utf8")),
    };
  } catch {
    return null;
  }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function materialDirectory(discussionId) {
  return `${discussionDirFor(discussionId)}/materials`;
}

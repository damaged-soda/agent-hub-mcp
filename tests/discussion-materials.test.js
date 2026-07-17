import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeMaterials, loadMaterialContext } from "../src/discussion-materials.js";
import { createDiscussionRecord } from "../src/discussion-store.js";

describe("discussion materials", () => {
  let root;
  let workspace;
  let previous;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "discussion-materials-"));
    workspace = path.join(root, "workspace");
    await fsp.mkdir(workspace, { recursive: true });
    previous = {
      AGENT_HUB_DISCUSSION_DIR: process.env.AGENT_HUB_DISCUSSION_DIR,
      AGENT_HUB_CWD_ALLOWLIST: process.env.AGENT_HUB_CWD_ALLOWLIST,
    };
    process.env.AGENT_HUB_DISCUSSION_DIR = path.join(root, "discussions");
    process.env.AGENT_HUB_CWD_ALLOWLIST = workspace;
  });

  afterEach(async () => {
    restore(previous);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("freezes inline and regular-file text with stable hashes", async () => {
    await createRecord("materials-one");
    await fsp.writeFile(path.join(workspace, "note.txt"), "file text\n");
    const manifest = await freezeMaterials("materials-one", workspace, [
      { material_id: "inline", type: "inline", title: "Inline", content: "inline text" },
      { material_id: "file", type: "file", title: "File", path: "note.txt" },
    ]);

    expect(manifest.total_bytes).toBe(Buffer.byteLength("inline textfile text\n"));
    expect(manifest.items.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
    const context = await loadMaterialContext("materials-one", manifest);
    expect(context.items.map((item) => item.content)).toEqual(["inline text", "file text\n"]);
  });

  it("rejects non-UTF-8 and out-of-allowlist files before acceptance", async () => {
    await createRecord("materials-two");
    const binary = path.join(workspace, "binary.txt");
    await fsp.writeFile(binary, Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(
      freezeMaterials("materials-two", workspace, [
        { material_id: "binary", type: "file", title: "Binary", path: binary },
      ]),
    ).rejects.toMatchObject({ code: "material_not_text" });

    const outside = path.join(root, "outside.txt");
    await fsp.writeFile(outside, "outside");
    await expect(
      freezeMaterials("materials-two", workspace, [
        { material_id: "outside", type: "file", title: "Outside", path: outside },
      ]),
    ).rejects.toThrow(/outside AGENT_HUB_CWD_ALLOWLIST/);
  });
});

async function createRecord(id) {
  const now = new Date().toISOString();
  await createDiscussionRecord(
    {
      schema_version: 1,
      discussion_id: id,
      status: "queued",
      phase: "preparing",
      created_at: now,
      updated_at: now,
    },
    { kind: "new" },
  );
}

function restore(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

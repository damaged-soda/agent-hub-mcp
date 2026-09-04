import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../src/cli.js";
import {
  EVAL_TOOLCHAIN_CAPSULE_KIND,
  computeEvalToolchainTreeDigest,
  evalToolchainCapsuleStatus,
  resolveEvalToolchainCapsule,
  writeEvalToolchainCapsuleManifest,
} from "../src/eval-toolchain.js";

describe("Eval toolchain capsules", () => {
  let scratch;

  beforeEach(async () => {
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-eval-toolchain-"));
  });

  afterEach(async () => {
    await makeDirectoriesWritable(scratch);
    await fsp.rm(scratch, { recursive: true, force: true });
  });

  it("writes and resolves a multi-command capsule without host discovery", async () => {
    const fixture = await writeToolchainFixture(path.join(scratch, "multi"));
    const resolved = await resolveEvalToolchainCapsule(fixture.manifest, {
      PATH: path.join(scratch, "must-not-be-used"),
    });

    expect(resolved).toMatchObject({
      kind: EVAL_TOOLCHAIN_CAPSULE_KIND,
      toolchain_id: "fixture-toolchain",
      platform: process.platform,
      arch: process.arch,
      root: await fsp.realpath(fixture.toolchainRoot),
      commands: {
        git: await fsp.realpath(fixture.executables.git),
        node: await fsp.realpath(fixture.executables.node),
        python3: await fsp.realpath(fixture.executables.python3),
      },
      read_paths: [await fsp.realpath(fixture.toolchainRoot)],
      manifest_path: await fsp.realpath(fixture.manifest),
      sealed: false,
    });
    expect(Object.keys(resolved.commands)).toEqual(["git", "node", "python3"]);
    expect(resolved.content_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("writes an exact manifest through the public CLI before the evaluator seals it", async () => {
    const directory = path.join(scratch, "cli-manifest");
    const toolchainRoot = path.join(directory, "toolchain");
    const executable = path.join(toolchainRoot, "bin", "node");
    await writeProgram(executable, "node");

    const result = await execute([
      "eval",
      "toolchain",
      "manifest",
      "--directory",
      directory,
      "--json",
      JSON.stringify({
        toolchain_id: "cli-toolchain",
        root: "toolchain",
        commands: { node: "bin/node" },
      }),
    ]);

    const expectedManifest = path.join(await fsp.realpath(directory), "manifest.json");
    expect(result).toEqual({
      status: "written",
      manifest_path: expectedManifest,
      toolchain: {
        kind: EVAL_TOOLCHAIN_CAPSULE_KIND,
        toolchain_id: "cli-toolchain",
        content_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        platform: process.platform,
        arch: process.arch,
        root: "toolchain",
        commands: { node: "bin/node" },
      },
    });
    expect((await fsp.stat(result.manifest_path)).mode & 0o777).toBe(0o600);
    await expect(resolveEvalToolchainCapsule(result.manifest_path)).resolves.toMatchObject({
      toolchain_id: "cli-toolchain",
      commands: { node: await fsp.realpath(executable) },
    });

    await sealFixture({ manifest: result.manifest_path, toolchainRoot });
    await expect(resolveEvalToolchainCapsule(result.manifest_path, {}, {
      require_sealed: true,
    })).resolves.toMatchObject({ sealed: true });
  });

  it("hashes the complete tree and a canonically sorted command map", async () => {
    const left = await writeToolchainFixture(path.join(scratch, "left"), {
      commands: {
        python3: "bin/python3",
        git: "bin/git",
        node: "bin/node",
      },
    });
    const right = await writeToolchainFixture(path.join(scratch, "right"), {
      commands: {
        node: "bin/node",
        python3: "bin/python3",
        git: "bin/git",
      },
    });
    const [leftResolved, rightResolved] = await Promise.all([
      resolveEvalToolchainCapsule(left.manifest),
      resolveEvalToolchainCapsule(right.manifest),
    ]);

    expect(await computeEvalToolchainTreeDigest(leftResolved.root))
      .toBe(await computeEvalToolchainTreeDigest(rightResolved.root));
    expect(leftResolved.content_digest).toBe(rightResolved.content_digest);

    await fsp.appendFile(right.executables.node, "changed\n");
    await expect(resolveEvalToolchainCapsule(right.manifest)).rejects.toMatchObject({
      code: "toolchain_capsule_invalid",
      message: "Eval toolchain capsule content digest does not match its manifest",
    });
  });

  it("binds command names and selected relative paths into the content digest", async () => {
    const left = await writeToolchainFixture(path.join(scratch, "map-left"), {
      commands: { node: "bin/node", runner: "bin/git" },
    });
    const right = await writeToolchainFixture(path.join(scratch, "map-right"), {
      commands: { node: "bin/git", runner: "bin/node" },
    });
    const [leftResolved, rightResolved] = await Promise.all([
      resolveEvalToolchainCapsule(left.manifest),
      resolveEvalToolchainCapsule(right.manifest),
    ]);

    expect(await computeEvalToolchainTreeDigest(leftResolved.root))
      .toBe(await computeEvalToolchainTreeDigest(rightResolved.root));
    expect(leftResolved.content_digest).not.toBe(rightResolved.content_digest);
  });

  it("allows only relative symlinks whose resolved targets remain inside the root", async () => {
    const directory = path.join(scratch, "safe-link");
    const toolchainRoot = path.join(directory, "toolchain");
    const realNode = path.join(toolchainRoot, "libexec", "node-real");
    await writeProgram(realNode, "node");
    await fsp.mkdir(path.join(toolchainRoot, "bin"), { recursive: true });
    await fsp.symlink("../libexec/node-real", path.join(toolchainRoot, "bin", "node"));
    const manifest = await writeEvalToolchainCapsuleManifest(directory, manifestFields({
      commands: { node: "bin/node" },
    }));

    const resolved = await resolveEvalToolchainCapsule(manifest);
    expect(resolved.commands.node).toBe(await fsp.realpath(realNode));

    const external = path.join(scratch, "external-node");
    await writeProgram(external, "external");
    const escapingDirectory = path.join(scratch, "escaping-link");
    const escapingRoot = path.join(escapingDirectory, "toolchain", "bin");
    await fsp.mkdir(escapingRoot, { recursive: true });
    await fsp.symlink(
      path.relative(escapingRoot, external),
      path.join(escapingRoot, "node"),
    );
    await expect(writeEvalToolchainCapsuleManifest(
      escapingDirectory,
      manifestFields({ commands: { node: "bin/node" } }),
    )).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });

    const absoluteDirectory = path.join(scratch, "absolute-link");
    const absoluteRoot = path.join(absoluteDirectory, "toolchain", "bin");
    await fsp.mkdir(absoluteRoot, { recursive: true });
    await fsp.symlink(external, path.join(absoluteRoot, "node"));
    await expect(writeEvalToolchainCapsuleManifest(
      absoluteDirectory,
      manifestFields({ commands: { node: "bin/node" } }),
    )).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });
  });

  it("rejects lexical path escapes, empty maps, and unsafe command basenames", async () => {
    const directory = path.join(scratch, "bad-fields");
    await writeProgram(path.join(directory, "toolchain", "bin", "node"), "node");

    await expect(writeEvalToolchainCapsuleManifest(directory, manifestFields({
      commands: { node: "../outside" },
    }))).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });
    await expect(writeEvalToolchainCapsuleManifest(directory, manifestFields({
      commands: {},
    }))).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });
    await expect(writeEvalToolchainCapsuleManifest(directory, manifestFields({
      commands: { "../node": "bin/node" },
    }))).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });
  });

  it("never writes a manifest larger than the resolver accepts", async () => {
    const directory = path.join(scratch, "oversized-manifest");
    await writeProgram(path.join(directory, "toolchain", "bin", "node"), "node");
    const commands = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [
        `command-${String(index).padStart(4, "0")}-${"x".repeat(114)}`,
        "bin/node",
      ]),
    );

    await expect(writeEvalToolchainCapsuleManifest(directory, manifestFields({ commands })))
      .rejects.toMatchObject({
        code: "toolchain_capsule_invalid",
        message: "Eval toolchain capsule manifest must be a small regular file",
      });
    await expect(fsp.stat(path.join(directory, "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-executable commands and command targets outside the root", async () => {
    const directory = path.join(scratch, "not-executable");
    const command = path.join(directory, "toolchain", "bin", "node");
    await fsp.mkdir(path.dirname(command), { recursive: true });
    await fsp.writeFile(command, "node\n", { mode: 0o600 });
    await fsp.chmod(command, 0o600);
    await expect(writeEvalToolchainCapsuleManifest(
      directory,
      manifestFields({ commands: { node: "bin/node" } }),
    )).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });
  });

  it("rejects manifest symlinks, root symlinks, and forbidden overlap", async () => {
    const fixture = await writeToolchainFixture(path.join(scratch, "boundaries"));
    const manifestLink = path.join(scratch, "manifest-link.json");
    await fsp.symlink(fixture.manifest, manifestLink);
    await expect(resolveEvalToolchainCapsule(manifestLink)).rejects.toMatchObject({
      code: "toolchain_capsule_invalid",
    });

    await expect(resolveEvalToolchainCapsule(fixture.manifest, {}, {
      forbidden_roots: [fixture.toolchainRoot],
    })).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });
    await expect(resolveEvalToolchainCapsule(fixture.manifest, {}, {
      forbidden_roots: [fixture.manifest],
    })).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });

    const rootLinkDirectory = path.join(scratch, "root-link");
    await fsp.mkdir(rootLinkDirectory);
    await fsp.symlink(fixture.toolchainRoot, path.join(rootLinkDirectory, "toolchain"));
    const linkedManifest = path.join(rootLinkDirectory, "manifest.json");
    await fsp.writeFile(linkedManifest, JSON.stringify({
      ...JSON.parse(await fsp.readFile(fixture.manifest, "utf8")),
      root: "toolchain",
    }));
    await expect(resolveEvalToolchainCapsule(linkedManifest)).rejects.toMatchObject({
      code: "toolchain_capsule_invalid",
    });
  });

  it("rejects hardlinks that hide external or forbidden file aliases", async () => {
    const fixture = await writeToolchainFixture(path.join(scratch, "hardlink"));
    const oracleDirectory = path.join(scratch, "private-oracle");
    await fsp.mkdir(oracleDirectory);
    await fsp.link(
      path.join(fixture.toolchainRoot, "NOTICE"),
      path.join(oracleDirectory, "standard-answer"),
    );
    await sealFixture(fixture);

    await expect(resolveEvalToolchainCapsule(fixture.manifest, {}, {
      forbidden_roots: [oracleDirectory],
      require_sealed: true,
    })).rejects.toMatchObject({
      code: "toolchain_capsule_invalid",
      message: expect.stringContaining("multiply-linked file"),
    });

    const manifestFixture = await writeToolchainFixture(path.join(scratch, "manifest-hardlink"));
    await fsp.link(
      manifestFixture.manifest,
      path.join(oracleDirectory, "manifest-alias"),
    );
    await expect(resolveEvalToolchainCapsule(manifestFixture.manifest)).rejects.toMatchObject({
      code: "toolchain_capsule_invalid",
      message: "Eval toolchain capsule manifest must be a small regular file",
    });
  });

  it("rejects cross-platform capsules and every non-absolute selector", async () => {
    const fixture = await writeToolchainFixture(path.join(scratch, "wrong-platform"), {
      platform: process.platform === "darwin" ? "linux" : "darwin",
    });
    await expect(resolveEvalToolchainCapsule(fixture.manifest)).rejects.toMatchObject({
      code: "toolchain_capsule_unsupported",
    });
    for (const selector of [undefined, "", "default", "fixture-toolchain", "./manifest.json"]) {
      await expect(resolveEvalToolchainCapsule(selector)).rejects.toMatchObject({
        code: "toolchain_capsule_unsupported",
      });
    }
  });

  it("optionally requires both the manifest object and root tree to be sealed", async () => {
    const fixture = await writeToolchainFixture(path.join(scratch, "seal"));
    await expect(resolveEvalToolchainCapsule(fixture.manifest, {}, {
      require_sealed: true,
    })).rejects.toMatchObject({
      code: "toolchain_capsule_invalid",
      message: "Eval toolchain capsule is not sealed",
    });

    await sealFixture(fixture);
    await expect(resolveEvalToolchainCapsule(fixture.manifest, {}, {
      require_sealed: true,
    })).resolves.toMatchObject({ sealed: true });
  });

  it.each(["manifest directory", "manifest", "root directory", "root file"])(
    "detects a writable %s in an otherwise sealed capsule",
    async (component) => {
      const fixture = await writeToolchainFixture(
        path.join(scratch, `seal-${component.replaceAll(" ", "-")}`),
      );
      await sealFixture(fixture);
      const targets = {
        "manifest directory": path.dirname(fixture.manifest),
        manifest: fixture.manifest,
        "root directory": fixture.toolchainRoot,
        "root file": path.join(fixture.toolchainRoot, "NOTICE"),
      };
      const target = targets[component];
      const mode = (await fsp.lstat(target)).mode & 0o777;
      await fsp.chmod(target, mode | 0o200);

      await expect(resolveEvalToolchainCapsule(fixture.manifest, {}, {
        require_sealed: true,
      })).rejects.toMatchObject({
        code: "toolchain_capsule_invalid",
        message: "Eval toolchain capsule is not sealed",
      });
    },
  );

  it("reports public status without exposing manifest or capsule paths", async () => {
    const fixture = await writeToolchainFixture(path.join(scratch, "status"));
    const ready = await evalToolchainCapsuleStatus(fixture.manifest);
    expect(ready).toEqual({
      status: "ready",
      toolchain: {
        kind: EVAL_TOOLCHAIN_CAPSULE_KIND,
        toolchain_id: "fixture-toolchain",
        content_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        platform: process.platform,
        arch: process.arch,
        commands: ["git", "node", "python3"],
      },
    });
    expect(JSON.stringify(ready)).not.toContain(scratch);

    const missingManifest = path.join(scratch, "private", "missing.json");
    const missing = await evalToolchainCapsuleStatus(missingManifest);
    expect(missing).toEqual({
      status: "missing",
      error: {
        code: "toolchain_capsule_missing",
        message: "Eval toolchain capsule is unavailable",
      },
    });
    expect(JSON.stringify(missing)).not.toContain(scratch);

    const unsupported = await evalToolchainCapsuleStatus("default");
    expect(unsupported).toEqual({
      status: "unsupported",
      error: {
        code: "toolchain_capsule_unsupported",
        message: "Eval toolchain capsule is unsupported",
      },
    });
  });

  it("rejects a manifest or root selected as an unsafe broad read path", async () => {
    const fixture = await writeToolchainFixture(path.join(scratch, "unsafe"));
    await expect(resolveEvalToolchainCapsule(fixture.manifest, {
      HOME: await fsp.realpath(path.dirname(fixture.manifest)),
    })).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });
    await expect(resolveEvalToolchainCapsule(fixture.manifest, {
      HOME: await fsp.realpath(fixture.toolchainRoot),
    })).rejects.toMatchObject({ code: "toolchain_capsule_invalid" });
  });
});

async function writeToolchainFixture(directory, overrides = {}) {
  const toolchainRoot = path.join(directory, "toolchain");
  const executables = {
    python3: path.join(toolchainRoot, "bin", "python3"),
    node: path.join(toolchainRoot, "bin", "node"),
    git: path.join(toolchainRoot, "bin", "git"),
  };
  await Promise.all(Object.entries(executables).map(([name, executable]) =>
    writeProgram(executable, name)
  ));
  await fsp.writeFile(path.join(toolchainRoot, "NOTICE"), "fixture toolchain\n");
  const manifest = await writeEvalToolchainCapsuleManifest(directory, manifestFields(overrides));
  return { directory, toolchainRoot, executables, manifest };
}

function manifestFields(overrides = {}) {
  return {
    toolchain_id: "fixture-toolchain",
    platform: process.platform,
    arch: process.arch,
    root: "toolchain",
    commands: {
      git: "bin/git",
      node: "bin/node",
      python3: "bin/python3",
    },
    ...overrides,
  };
}

async function writeProgram(target, name) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `#!/bin/sh\nprintf '%s\\n' ${name}\n`, { mode: 0o755 });
  await fsp.chmod(target, 0o755);
}

async function sealFixture(fixture) {
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(target);
        await fsp.chmod(target, 0o555);
      } else if (stat.isFile()) {
        await fsp.chmod(target, stat.mode & 0o100 ? 0o555 : 0o444);
      }
    }
  }
  await visit(fixture.toolchainRoot);
  await fsp.chmod(fixture.toolchainRoot, 0o555);
  await fsp.chmod(fixture.manifest, 0o444);
  await fsp.chmod(path.dirname(fixture.manifest), 0o555);
}

async function makeDirectoriesWritable(directory) {
  const stat = await fsp.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  await fsp.chmod(directory, 0o700).catch(() => undefined);
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeDirectoriesWritable(path.join(directory, entry.name));
    }
  }
}

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PYTHON_RUNTIME_CAPSULE_KIND,
  PYTHON_RUNTIME_CAPSULES,
  PYTHON_RUNTIME_SELFTEST_ARGS,
  computeRuntimeTreeDigest,
  createRuntimeCommandBin,
  getEvalRuntimeRoot,
  installPythonRuntimeCapsule,
  parsePythonRuntimeSelftest,
  pythonRuntimeCapsuleStatus,
  pythonRuntimeSelftestEnvironment,
  resolvePythonRuntimeCapsule,
  validatePythonRuntimeSelftest,
  writePythonRuntimeCapsuleManifest,
} from "../src/eval-runtime.js";

const execFileAsync = promisify(execFile);
const EXPECTED_CHECKS = ["bz2", "ctypes", "lzma", "sqlite3", "ssl"];

describe("Eval Python runtime capsules", () => {
  let root;
  let readonlyDirs;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-eval-runtime-"));
    readonlyDirs = [];
  });

  afterEach(async () => {
    for (const directory of readonlyDirs) {
      await fsp.chmod(directory, 0o700).catch(() => undefined);
    }
    await makeDirectoriesWritable(root);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("pins the four supported python-build-standalone artifacts", () => {
    expect(PYTHON_RUNTIME_CAPSULES).toEqual(expect.objectContaining({
      "python-build-standalone-3.12.14+20260825-darwin-arm64": expect.objectContaining({
        platform: "darwin",
        arch: "arm64",
        archive_sha256:
          "sha256:62eef3fcf48fa4f792d0d6d267c140b81aaea0edca4ae0641d8021854314f966",
      }),
      "python-build-standalone-3.12.14+20260825-darwin-x64": expect.objectContaining({
        platform: "darwin",
        arch: "x64",
        archive_sha256:
          "sha256:65da7bc373ea36cb7e413f2a20bcced9eeb7e5a83fa554ce9f6ec79abb8d7e31",
      }),
      "python-build-standalone-3.12.14+20260825-linux-arm64": expect.objectContaining({
        platform: "linux",
        arch: "arm64",
        archive_sha256:
          "sha256:70162d3fa61a7bf52a9f098ad6f46046f9813ab50e0d2b3cfeb81ee1bad78f1c",
      }),
      "python-build-standalone-3.12.14+20260825-linux-x64": expect.objectContaining({
        platform: "linux",
        arch: "x64",
        archive_sha256:
          "sha256:cbdd2f0cf02f941bc5c81e546f377275e322733abffe805ac29d2b7e8a58f7e3",
      }),
    }));
    expect(Object.keys(PYTHON_RUNTIME_CAPSULES)).toHaveLength(4);
    for (const artifact of Object.values(PYTHON_RUNTIME_CAPSULES)) {
      expect(artifact.python_version).toBe("3.12.14");
      expect(artifact.url).toMatch(
        /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\/20260825\//,
      );
      expect(artifact.url).toContain("install_only.tar.gz");
      expect(artifact.root).toBe("python");
      expect(artifact.commands).toEqual({ python3: "bin/python3" });
      expect(Object.isFrozen(artifact)).toBe(true);
    }
  });

  it("resolves the private content store without depending on PATH", () => {
    expect(getEvalRuntimeRoot({ AGENT_HUB_EVAL_RUNTIME_DIR: path.join(root, "override") }))
      .toBe(path.join(root, "override"));
    expect(getEvalRuntimeRoot({ XDG_CACHE_HOME: path.join(root, "cache") }))
      .toBe(path.join(root, "cache", "agent-hub-mcp", "eval-runtimes"));
    expect(getEvalRuntimeRoot({})).toBe(
      path.join(os.homedir(), ".cache", "agent-hub-mcp", "eval-runtimes"),
    );
  });

  it("uses a no-bytecode isolated self-test that exercises native stdlib modules", () => {
    expect(PYTHON_RUNTIME_SELFTEST_ARGS.slice(0, 3)).toEqual(["-I", "-B", "-c"]);
    expect(PYTHON_RUNTIME_SELFTEST_ARGS).not.toContain("-S");
    for (const moduleName of EXPECTED_CHECKS) {
      expect(PYTHON_RUNTIME_SELFTEST_ARGS[3]).toContain(moduleName);
    }
    expect(PYTHON_RUNTIME_SELFTEST_ARGS[3]).toContain("sqlite3.connect(':memory:')");
    expect(PYTHON_RUNTIME_SELFTEST_ARGS[3]).toContain("ssl.RAND_bytes");
    expect(Object.isFrozen(PYTHON_RUNTIME_SELFTEST_ARGS)).toBe(true);
  });

  it("sanitizes the provisioning self-test environment", () => {
    expect(pythonRuntimeSelftestEnvironment({
      HOME: "/tmp/home",
      LANG: "C",
      OPENAI_API_KEY: "must-not-pass",
      PATH: "/untrusted/bin",
      PYTHONPATH: "/untrusted/python",
    })).toEqual({
      HOME: "/tmp/home",
      LANG: "C",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONPATH: "",
    });
  });

  it("parses only the fixed native self-test result contract", () => {
    const output = selftestOutput({
      executable: "/capsule/bin/python3",
      prefix: "/capsule",
      base_prefix: "/capsule",
    });
    expect(parsePythonRuntimeSelftest(output, { python_version: "3.12.14" })).toEqual({
      executable: "/capsule/bin/python3",
      prefix: "/capsule",
      base_prefix: "/capsule",
      python_version: "3.12.14",
      checks: EXPECTED_CHECKS,
    });
    expect(() => parsePythonRuntimeSelftest("not-json"))
      .toThrow(/self-test output is invalid/);
    expect(() => parsePythonRuntimeSelftest(JSON.stringify({
      ...JSON.parse(output),
      checks: ["sqlite3"],
    }))).toThrow(/self-test output is invalid/);
    expect(() => parsePythonRuntimeSelftest(output, { python_version: "3.12.13" }))
      .toThrow(/self-test output is invalid/);
  });

  it("writes and resolves a strict manifest with canonical in-root commands", async () => {
    const fixture = await writeCapsuleFixture(path.join(root, "custom capsule"));

    const runtime = await resolvePythonRuntimeCapsule(fixture.manifest, {}, {
      platform: process.platform,
      arch: process.arch,
    });

    expect(runtime).toMatchObject({
      kind: PYTHON_RUNTIME_CAPSULE_KIND,
      runtime_id: fixture.runtimeId,
      python_version: "3.12.14",
      platform: process.platform,
      arch: process.arch,
      root: await fsp.realpath(fixture.runtimeRoot),
      commands: { python3: await fsp.realpath(fixture.executable) },
      read_paths: [await fsp.realpath(fixture.runtimeRoot)],
      manifest_path: await fsp.realpath(fixture.manifest),
    });
    expect(runtime.content_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("validates self-test identity against the resolved capsule", async () => {
    const fixture = await writeCapsuleFixture(path.join(root, "identity"));
    const runtime = await resolvePythonRuntimeCapsule(fixture.manifest);
    const valid = selftestOutput({
      executable: fixture.executable,
      prefix: fixture.runtimeRoot,
      base_prefix: fixture.runtimeRoot,
    });
    await expect(validatePythonRuntimeSelftest(valid, runtime)).resolves.toMatchObject({
      python_version: "3.12.14",
      checks: EXPECTED_CHECKS,
    });
    await expect(validatePythonRuntimeSelftest(selftestOutput({
      executable: fixture.executable,
      prefix: root,
      base_prefix: fixture.runtimeRoot,
    }), runtime)).rejects.toMatchObject({ code: "runtime_capsule_selftest_failed" });
  });

  it("rejects content modified after the manifest was written", async () => {
    const fixture = await writeCapsuleFixture(path.join(root, "modified"));
    await fsp.appendFile(fixture.executable, "\nmodified\n");

    await expect(resolvePythonRuntimeCapsule(fixture.manifest)).rejects.toMatchObject({
      code: "runtime_capsule_invalid",
      message: "Python runtime capsule content digest does not match its manifest",
    });
  });

  it("computes a deterministic digest over names, modes, links, and bytes", async () => {
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    for (const directory of [left, right]) {
      await fsp.mkdir(path.join(directory, "bin"), { recursive: true });
      await fsp.writeFile(path.join(directory, "bin", "python3.12"), "same\n", { mode: 0o755 });
      await fsp.chmod(path.join(directory, "bin", "python3.12"), 0o755);
      await fsp.symlink("python3.12", path.join(directory, "bin", "python3"));
      await fsp.writeFile(path.join(directory, "README"), "capsule\n");
    }
    expect(await computeRuntimeTreeDigest(left)).toBe(await computeRuntimeTreeDigest(right));
    await fsp.appendFile(path.join(right, "README"), "changed\n");
    expect(await computeRuntimeTreeDigest(left)).not.toBe(await computeRuntimeTreeDigest(right));
  });

  it("binds the selected command into the public capsule content digest", async () => {
    const manifests = [];
    for (const [name, command] of [["command-a", "bin/python-a"], ["command-b", "bin/python-b"]]) {
      const manifestDirectory = path.join(root, name);
      const runtimeRoot = path.join(manifestDirectory, "python");
      await Promise.all([
        writeShellProgram(path.join(runtimeRoot, "bin", "python-a"), "exit 0"),
        writeShellProgram(path.join(runtimeRoot, "bin", "python-b"), "exit 0"),
      ]);
      manifests.push(await writePythonRuntimeCapsuleManifest(manifestDirectory, {
        ...manifestFields("same-runtime-identity"),
        commands: { python3: command },
      }));
    }

    const [left, right] = await Promise.all(
      manifests.map((manifest) => resolvePythonRuntimeCapsule(manifest)),
    );
    expect(await computeRuntimeTreeDigest(left.root)).toBe(await computeRuntimeTreeDigest(right.root));
    expect(left.content_digest).not.toBe(right.content_digest);
  });

  it.each([
    ["absolute", "/outside/python3"],
    ["escaping", "../../../outside/python3"],
  ])("rejects %s symlinks", async (_kind, target) => {
    const runtimeRoot = path.join(root, `symlink-${_kind}`);
    await fsp.mkdir(path.join(runtimeRoot, "bin"), { recursive: true });
    await fsp.symlink(target, path.join(runtimeRoot, "bin", "python3"));
    await expect(computeRuntimeTreeDigest(runtimeRoot)).rejects.toMatchObject({
      code: "runtime_capsule_invalid",
    });
  });

  it("rejects special files in a capsule tree", async () => {
    const runtimeRoot = path.join(root, "special");
    await fsp.mkdir(runtimeRoot);
    await execFileAsync("/usr/bin/mkfifo", [path.join(runtimeRoot, "runtime.fifo")]);
    await expect(computeRuntimeTreeDigest(runtimeRoot)).rejects.toMatchObject({
      code: "runtime_capsule_invalid",
    });
  });

  it("rejects non-executable commands and forbidden-root overlap", async () => {
    const manifestDirectory = path.join(root, "invalid-command");
    const runtimeRoot = path.join(manifestDirectory, "python");
    await fsp.mkdir(path.join(runtimeRoot, "bin"), { recursive: true });
    await fsp.writeFile(path.join(runtimeRoot, "bin", "python3"), "blocked\n", { mode: 0o600 });
    await expect(writePythonRuntimeCapsuleManifest(manifestDirectory, manifestFields("blocked")))
      .rejects.toMatchObject({ code: "runtime_capsule_invalid" });

    const fixture = await writeCapsuleFixture(path.join(root, "forbidden"));
    await expect(resolvePythonRuntimeCapsule(fixture.manifest, {}, {
      forbidden_roots: [fixture.runtimeRoot],
    })).rejects.toMatchObject({ code: "runtime_capsule_invalid" });
  });

  it("rejects missing, cross-platform, and unpinned named capsules", async () => {
    const missing = path.join(root, "missing", "manifest.json");
    await expect(resolvePythonRuntimeCapsule(missing)).rejects.toMatchObject({
      code: "runtime_capsule_missing",
      message: `Python runtime capsule manifest is unavailable: ${missing}`,
    });

    const fixture = await writeCapsuleFixture(path.join(root, "wrong-platform"), {
      platform: process.platform === "darwin" ? "linux" : "darwin",
    });
    await expect(resolvePythonRuntimeCapsule(fixture.manifest)).rejects.toMatchObject({
      code: "runtime_capsule_unsupported",
    });

    await expect(resolvePythonRuntimeCapsule("not-in-the-pinned-catalog", {
      AGENT_HUB_EVAL_RUNTIME_DIR: path.join(root, "store"),
    })).rejects.toMatchObject({ code: "runtime_capsule_unsupported" });
  });

  it("does not inspect or execute host PATH when the default capsule is missing", async () => {
    const marker = path.join(root, "host-python-ran");
    const hostBin = path.join(root, "host-bin");
    await writeShellProgram(
      path.join(hostBin, "python3"),
      `printf ran > ${shellQuote(marker)}`,
    );
    const store = path.join(root, "empty-store");

    await expect(resolvePythonRuntimeCapsule("default", {
      AGENT_HUB_EVAL_RUNTIME_DIR: store,
      PATH: hostBin,
    })).rejects.toMatchObject({ code: "runtime_capsule_missing" });
    await expect(fsp.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports status without exposing local capsule paths", async () => {
    const fixture = await writeCapsuleFixture(path.join(root, "status"));
    const ready = await pythonRuntimeCapsuleStatus(fixture.manifest);
    expect(ready).toEqual({
      status: "ready",
      toolchain: {
        kind: PYTHON_RUNTIME_CAPSULE_KIND,
        runtime_id: fixture.runtimeId,
        python_version: "3.12.14",
        content_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        platform: process.platform,
        arch: process.arch,
      },
    });
    expect(JSON.stringify(ready)).not.toContain(root);

    const missing = await pythonRuntimeCapsuleStatus(path.join(root, "gone", "manifest.json"));
    expect(missing).toMatchObject({
      status: "missing",
      error: { code: "runtime_capsule_missing" },
    });
  });

  it("does not treat an absolute manifest as an install request", async () => {
    const fixture = await writeCapsuleFixture(path.join(root, "already-present"));
    await expect(installPythonRuntimeCapsule(fixture.manifest)).rejects.toMatchObject({
      code: "runtime_capsule_unsupported",
    });
  });

  it("installs a verified archive atomically into the content-addressed store", async () => {
    const archive = Buffer.from("fixture capsule archive\n");
    const selectedArtifact = fixtureArtifact(archive);
    const store = path.join(root, "store");
    let downloads = 0;
    const internal = {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => {
        downloads += 1;
        await fsp.writeFile(target, archive);
      },
      list_archive: async () => ["python/bin/python3"],
      extract_archive: async (_archivePath, destination) => {
        const runtimeRoot = path.join(destination, "python");
        const executable = path.join(runtimeRoot, "bin", "python3");
        await writeSelftestProgram(executable, runtimeRoot);
      },
    };
    const env = { AGENT_HUB_EVAL_RUNTIME_DIR: store };

    const installed = await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    expect(installed).toEqual({
      status: "ready",
      toolchain: expect.objectContaining({
        kind: PYTHON_RUNTIME_CAPSULE_KIND,
        runtime_id: selectedArtifact.runtime_id,
        python_version: "3.12.14",
      }),
    });
    expect(JSON.stringify(installed)).not.toContain(store);
    const runtime = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    expect(runtime.root).toMatch(/objects\/sha256\/[a-f0-9]{64}\/python$/);
    for (const target of [
      path.dirname(runtime.manifest_path),
      runtime.manifest_path,
      runtime.root,
      runtime.commands.python3,
    ]) {
      expect((await fsp.stat(target)).mode & 0o222).toBe(0);
    }
    expect(await fsp.readFile(
      path.join(store, "refs", selectedArtifact.runtime_id),
      "utf8",
    )).toBe(`${runtime.content_digest.slice("sha256:".length)}\n`);

    await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    expect(downloads).toBe(1);
  });

  it("repairs a corrupt content object from a freshly verified archive", async () => {
    const archive = Buffer.from("repairable fixture capsule archive\n");
    const selectedArtifact = fixtureArtifact(archive);
    const store = path.join(root, "repair-store");
    let downloads = 0;
    const internal = {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => {
        downloads += 1;
        await fsp.writeFile(target, archive);
      },
      list_archive: async () => ["python/bin/python3"],
      extract_archive: async (_archivePath, destination) => {
        const runtimeRoot = path.join(destination, "python");
        await writeSelftestProgram(path.join(runtimeRoot, "bin", "python3"), runtimeRoot);
      },
    };
    const env = { AGENT_HUB_EVAL_RUNTIME_DIR: store };
    await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    const before = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    await fsp.chmod(before.commands.python3, 0o755);
    await fsp.appendFile(before.commands.python3, "\ntampered\n");

    await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);

    const repaired = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    expect(repaired.content_digest).toBe(before.content_digest);
    expect(downloads).toBe(2);
    expect((await fsp.readdir(path.join(store, "objects", "sha256")))
      .filter((name) => name.startsWith(".invalid-"))).toHaveLength(1);
  });

  it("rejects a catalog object whose read-only seal was changed without changing bytes", async () => {
    const archive = Buffer.from("seal integrity fixture\n");
    const selectedArtifact = fixtureArtifact(archive);
    const store = path.join(root, "seal-integrity-store");
    const internal = {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => fsp.writeFile(target, archive),
      list_archive: async () => ["python/bin/python3"],
      extract_archive: async (_archivePath, destination) => {
        const runtimeRoot = path.join(destination, "python");
        await writeSelftestProgram(path.join(runtimeRoot, "bin", "python3"), runtimeRoot);
      },
    };
    const env = { AGENT_HUB_EVAL_RUNTIME_DIR: store };
    await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    const runtime = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    await fsp.chmod(runtime.commands.python3, 0o755);

    await expect(resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal))
      .rejects.toMatchObject({
        code: "runtime_capsule_invalid",
        message: "Installed runtime capsule is not sealed",
      });
  });

  it("repairs a corrupt runtime reference without replacing a valid object", async () => {
    const archive = Buffer.from("ref repair fixture capsule archive\n");
    const selectedArtifact = fixtureArtifact(archive);
    const store = path.join(root, "ref-repair-store");
    let downloads = 0;
    const internal = {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => {
        downloads += 1;
        await fsp.writeFile(target, archive);
      },
      list_archive: async () => ["python/bin/python3"],
      extract_archive: async (_archivePath, destination) => {
        const runtimeRoot = path.join(destination, "python");
        await writeSelftestProgram(path.join(runtimeRoot, "bin", "python3"), runtimeRoot);
      },
    };
    const env = { AGENT_HUB_EVAL_RUNTIME_DIR: store };
    await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    const original = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    await fsp.writeFile(path.join(store, "refs", selectedArtifact.runtime_id), `${"0".repeat(64)}\n`);

    await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);

    const repaired = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    expect(repaired.content_digest).toBe(original.content_digest);
    expect(downloads).toBe(2);
  });

  it("quarantines a symlinked object slot without changing its external target", async () => {
    const archive = Buffer.from("symlinked slot fixture\n");
    const selectedArtifact = fixtureArtifact(archive);
    const store = path.join(root, "symlink-slot-store");
    const internal = {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => fsp.writeFile(target, archive),
      list_archive: async () => ["python/bin/python3"],
      extract_archive: async (_archivePath, destination) => {
        const runtimeRoot = path.join(destination, "python");
        await writeSelftestProgram(path.join(runtimeRoot, "bin", "python3"), runtimeRoot);
      },
    };
    const env = { AGENT_HUB_EVAL_RUNTIME_DIR: store };
    const installed = await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    const digestHex = installed.toolchain.content_digest.slice("sha256:".length);
    const objectSlot = path.join(store, "objects", "sha256", digestHex);
    await fsp.rename(objectSlot, path.join(path.dirname(objectSlot), ".detached-original-object"));
    const external = path.join(root, "external-target");
    await fsp.mkdir(external, { mode: 0o755 });
    await fsp.chmod(external, 0o755);
    await fsp.symlink(external, objectSlot);

    await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);

    expect((await fsp.stat(external)).mode & 0o777).toBe(0o755);
    const objectParent = path.join(store, "objects", "sha256");
    const quarantineEntries = (await fsp.readdir(objectParent))
      .filter((name) => name.startsWith(".invalid-"));
    expect(quarantineEntries).toHaveLength(1);
    expect((await fsp.lstat(path.join(objectParent, quarantineEntries[0])))
      .isSymbolicLink()).toBe(true);
  });

  it("serializes concurrent publication of the same sealed content object", async () => {
    const archive = Buffer.from("concurrent capsule fixture\n");
    const selectedArtifact = fixtureArtifact(archive);
    const store = path.join(root, "concurrent-store");
    let arrivals = 0;
    let releaseExtractors;
    const bothExtracted = new Promise((resolve) => {
      releaseExtractors = resolve;
    });
    const internal = {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => fsp.writeFile(target, archive),
      list_archive: async () => ["python/bin/python3"],
      extract_archive: async (_archivePath, destination) => {
        const runtimeRoot = path.join(destination, "python");
        await writeSelftestProgram(path.join(runtimeRoot, "bin", "python3"), runtimeRoot);
        arrivals += 1;
        if (arrivals === 2) releaseExtractors();
        await bothExtracted;
      },
    };
    const env = { AGENT_HUB_EVAL_RUNTIME_DIR: store };

    const [left, right] = await Promise.all([
      installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal),
      installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal),
    ]);

    expect(left.toolchain).toEqual(right.toolchain);
    const runtime = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    expect(runtime.content_digest).toBe(left.toolchain.content_digest);
    expect((await fsp.stat(path.dirname(runtime.manifest_path))).mode & 0o222).toBe(0);
  });

  it("rejects a manifest stored under a content-address that does not match its tree", async () => {
    const archive = Buffer.from("wrong content slot fixture\n");
    const selectedArtifact = fixtureArtifact(archive);
    const store = path.join(root, "wrong-slot-store");
    const internal = {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => fsp.writeFile(target, archive),
      list_archive: async () => ["python/bin/python3"],
      extract_archive: async (_archivePath, destination) => {
        const runtimeRoot = path.join(destination, "python");
        await writeSelftestProgram(path.join(runtimeRoot, "bin", "python3"), runtimeRoot);
      },
    };
    const env = { AGENT_HUB_EVAL_RUNTIME_DIR: store };
    const installed = await installPythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal);
    const digestHex = installed.toolchain.content_digest.slice("sha256:".length);
    const wrongHex = "0".repeat(64);
    await fsp.rename(
      path.join(store, "objects", "sha256", digestHex),
      path.join(store, "objects", "sha256", wrongHex),
    );
    await fsp.writeFile(path.join(store, "refs", selectedArtifact.runtime_id), `${wrongHex}\n`);

    await expect(resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, internal))
      .rejects.toMatchObject({
        code: "runtime_capsule_invalid",
        message: "Python runtime capsule object does not match its content-addressed reference",
      });
  });

  it("rejects an archive with the wrong digest before listing or extraction", async () => {
    const archive = Buffer.from("tampered archive\n");
    const selectedArtifact = {
      ...fixtureArtifact(Buffer.from("expected archive\n")),
      archive_size: archive.length,
    };
    let listed = false;
    await expect(installPythonRuntimeCapsule(selectedArtifact.runtime_id, {
      AGENT_HUB_EVAL_RUNTIME_DIR: path.join(root, "bad-digest-store"),
    }, {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => fsp.writeFile(target, archive),
      list_archive: async () => {
        listed = true;
        return ["python/bin/python3"];
      },
    })).rejects.toMatchObject({ code: "runtime_capsule_download_failed" });
    expect(listed).toBe(false);
  });

  it("rejects traversal and unexpected roots before extracting an archive", async () => {
    const archive = Buffer.from("safe-hash-unsafe-list\n");
    const selectedArtifact = fixtureArtifact(archive);
    let extracted = false;
    await expect(installPythonRuntimeCapsule(selectedArtifact.runtime_id, {
      AGENT_HUB_EVAL_RUNTIME_DIR: path.join(root, "unsafe-list-store"),
    }, {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => fsp.writeFile(target, archive),
      list_archive: async () => ["python/bin/python3", "../escape"],
      extract_archive: async () => {
        extracted = true;
      },
    })).rejects.toMatchObject({ code: "runtime_capsule_invalid" });
    expect(extracted).toBe(false);
  });

  it("runs archive tooling with a fixed environment instead of caller tar hooks", async () => {
    const archive = Buffer.from("archive environment fixture\n");
    const selectedArtifact = fixtureArtifact(archive);
    const store = path.join(root, "archive-env-store");
    const seenEnvironments = [];
    await installPythonRuntimeCapsule(selectedArtifact.runtime_id, {
      AGENT_HUB_EVAL_RUNTIME_DIR: store,
      PATH: path.join(root, "hostile-bin"),
      TAR_OPTIONS: "--checkpoint=1 --checkpoint-action=exec=hostile",
      GZIP: "-9",
      DYLD_INSERT_LIBRARIES: "/hostile.dylib",
      LD_PRELOAD: "/hostile.so",
    }, {
      artifact: selectedArtifact,
      platform: process.platform,
      arch: process.arch,
      download_file: async (_artifact, target) => fsp.writeFile(target, archive),
      archive_run_command: async (_command, args, options) => {
        seenEnvironments.push(options.env);
        if (args[0] === "-tzf") {
          return { code: 0, stdout: "python/bin/python3\n", stderr: "" };
        }
        const destination = args[args.indexOf("-C") + 1];
        const runtimeRoot = path.join(destination, "python");
        await writeSelftestProgram(path.join(runtimeRoot, "bin", "python3"), runtimeRoot);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(seenEnvironments).toEqual([
      { LANG: "C", LC_ALL: "C", LC_CTYPE: "C", PATH: "/usr/bin:/bin" },
      { LANG: "C", LC_ALL: "C", LC_CTYPE: "C", PATH: "/usr/bin:/bin" },
    ]);
  });

  it("rejects a named catalog entry for a different host architecture", async () => {
    const foreign = Object.values(PYTHON_RUNTIME_CAPSULES).find(
      (item) => item.platform === process.platform && item.arch !== process.arch,
    );
    if (!foreign) return;
    await expect(resolvePythonRuntimeCapsule(foreign.runtime_id, {
      AGENT_HUB_EVAL_RUNTIME_DIR: path.join(root, "foreign-store"),
    })).rejects.toMatchObject({ code: "runtime_capsule_unsupported" });
  });

  it("creates canonical read-only command symlinks that preserve every argument", async () => {
    const parent = path.join(root, "private parent");
    const executable = path.join(root, "runtime with quote's", "python3");
    const reportedExecutable = path.join(root, "capsule", "bin", "python3");
    await fsp.mkdir(parent);
    await writeProgram(
      executable,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    );
    await fsp.mkdir(path.dirname(reportedExecutable), { recursive: true });
    await fsp.symlink(executable, reportedExecutable);

    const commandBin = await createRuntimeCommandBin(parent, { python3: reportedExecutable });
    readonlyDirs.push(commandBin);
    const wrapperPath = path.join(commandBin, "python3");
    expect((await fsp.lstat(wrapperPath)).isSymbolicLink()).toBe(true);
    expect(await fsp.readlink(wrapperPath)).toBe(await fsp.realpath(executable));
    expect((await fsp.stat(commandBin)).mode & 0o777).toBe(0o555);

    const { stdout } = await execFileAsync(wrapperPath, ["-m", "unit test", "a'b", ""]);
    expect(JSON.parse(stdout)).toEqual(["-m", "unit test", "a'b", ""]);
  });

  it.each(["", ".python3", "../python3", "python/3", "python 3", "python+3"])(
    "rejects invalid command overlay name %j",
    async (name) => {
      const parent = path.join(root, `invalid-${Buffer.from(name).toString("hex") || "empty"}`);
      const executable = path.join(root, "valid", "python3");
      await fsp.mkdir(parent);
      await writeProgram(executable, "process.exit(0);");
      await expect(createRuntimeCommandBin(parent, { [name]: executable }))
        .rejects.toThrow(/Invalid runtime command name/);
      await expect(fsp.access(path.join(parent, "runtime-bin")))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects relative, missing, and non-executable overlay targets", async () => {
    const relativeParent = path.join(root, "relative");
    const missingParent = path.join(root, "missing");
    const blockedParent = path.join(root, "blocked");
    await Promise.all([
      fsp.mkdir(relativeParent),
      fsp.mkdir(missingParent),
      fsp.mkdir(blockedParent),
    ]);
    const blocked = path.join(root, "blocked-python");
    await fsp.writeFile(blocked, "#!/bin/sh\nexit 0\n", { mode: 0o600 });

    await expect(createRuntimeCommandBin(relativeParent, { python3: "python3" }))
      .rejects.toThrow(/absolute executable/);
    await expect(createRuntimeCommandBin(missingParent, {
      python3: path.join(root, "does-not-exist"),
    })).rejects.toThrow(/unavailable/);
    await expect(createRuntimeCommandBin(blockedParent, { python3: blocked }))
      .rejects.toThrow(/unavailable/);
  });
});

async function writeCapsuleFixture(manifestDirectory, overrides = {}) {
  const runtimeRoot = path.join(manifestDirectory, "python");
  const executable = path.join(runtimeRoot, "bin", "python3");
  await writeShellProgram(executable, "exit 0");
  const runtimeId = overrides.runtime_id ?? `fixture-${path.basename(manifestDirectory).replaceAll(" ", "-")}`;
  const manifest = await writePythonRuntimeCapsuleManifest(manifestDirectory, {
    ...manifestFields(runtimeId),
    ...overrides,
  });
  return { manifest, manifestDirectory, runtimeRoot, executable, runtimeId };
}

function manifestFields(runtimeId) {
  return {
    runtime_id: runtimeId,
    python_version: "3.12.14",
    platform: process.platform,
    arch: process.arch,
    root: "python",
    commands: { python3: "bin/python3" },
  };
}

function selftestOutput({ executable, prefix, base_prefix: basePrefix, pythonVersion = "3.12.14" }) {
  return JSON.stringify({
    executable,
    prefix,
    base_prefix: basePrefix,
    python_version: pythonVersion,
    checks: EXPECTED_CHECKS,
  });
}

function fixtureArtifact(archive) {
  const runtimeId = `fixture-install-${process.platform}-${process.arch}`;
  return {
    runtime_id: runtimeId,
    python_version: "3.12.14",
    platform: process.platform,
    arch: process.arch,
    url: "https://example.invalid/python-runtime.tar.gz",
    archive_sha256: `sha256:${crypto.createHash("sha256").update(archive).digest("hex")}`,
    archive_size: archive.length,
    root: "python",
    commands: { python3: "bin/python3" },
  };
}

async function writeSelftestProgram(target, runtimeRoot) {
  await writeProgram(
    target,
    "const executable = process.argv[1];\n" +
      `const root = executable.slice(0, -${JSON.stringify("/bin/python3".length)});\n` +
      `process.stdout.write(JSON.stringify({python_version:"3.12.14",` +
      `checks:${JSON.stringify(EXPECTED_CHECKS)},executable,prefix:root,base_prefix:root}));`,
  );
}

async function writeProgram(target, body) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  await fsp.chmod(target, 0o755);
}

async function writeShellProgram(target, body) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await fsp.chmod(target, 0o755);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function makeDirectoriesWritable(directory) {
  const stat = await fsp.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  await fsp.chmod(directory, 0o700).catch(() => undefined);
  for (const entry of await fsp.readdir(directory).catch(() => [])) {
    await makeDirectoriesWritable(path.join(directory, entry));
  }
}

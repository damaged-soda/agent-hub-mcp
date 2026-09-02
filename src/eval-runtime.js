import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./adapter-utils.js";

export const PYTHON_RUNTIME_CAPSULE_KIND = "python-runtime-capsule/v1";
export const PYTHON_RUNTIME_MANIFEST_NAME = "manifest.json";

const PYTHON_VERSION = "3.12.14";
const PYTHON_BUILD_RELEASE = "20260825";
const RELEASE_URL =
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_RELEASE}`;
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_LIST_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const SELFTEST_CHECKS = Object.freeze(["bz2", "ctypes", "lzma", "sqlite3", "ssl"]);
const SELFTEST_ENV_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
]);

const SELFTEST_SOURCE = [
  "import bz2, ctypes, json, lzma, platform, sqlite3, ssl, sys",
  "payload = b'agent-hub-runtime-capsule-v1'",
  "assert bz2.decompress(bz2.compress(payload)) == payload",
  "assert lzma.decompress(lzma.compress(payload)) == payload",
  "db = sqlite3.connect(':memory:')",
  "db.execute('create table smoke(value text)')",
  "db.execute(\"insert into smoke values ('ready')\")",
  "assert db.execute('select value from smoke').fetchone() == ('ready',)",
  "db.close()",
  "assert len(ssl.RAND_bytes(16)) == 16",
  "assert ctypes.sizeof(ctypes.c_void_p) > 0",
  "print(json.dumps({",
  "    'executable': sys.executable,",
  "    'prefix': sys.prefix,",
  "    'base_prefix': sys.base_prefix,",
  "    'python_version': platform.python_version(),",
  "    'checks': ['bz2', 'ctypes', 'lzma', 'sqlite3', 'ssl'],",
  "}, sort_keys=True))",
].join("\n");

export const PYTHON_RUNTIME_SELFTEST_ARGS = Object.freeze([
  "-I",
  "-B",
  "-c",
  SELFTEST_SOURCE,
]);

function artifact({ platform, arch, upstreamArch, upstreamPlatform, archiveSha256, archiveSize }) {
  const runtimeId =
    `python-build-standalone-${PYTHON_VERSION}+${PYTHON_BUILD_RELEASE}-${platform}-${arch}`;
  const filename =
    `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_RELEASE}-${upstreamArch}-${upstreamPlatform}` +
    "-install_only.tar.gz";
  return Object.freeze({
    runtime_id: runtimeId,
    python_version: PYTHON_VERSION,
    platform,
    arch,
    url: `${RELEASE_URL}/${filename.replace("+", "%2B")}`,
    archive_sha256: `sha256:${archiveSha256}`,
    archive_size: archiveSize,
    root: "python",
    commands: Object.freeze({ python3: "bin/python3" }),
  });
}

const CATALOG = [
  artifact({
    platform: "darwin",
    arch: "arm64",
    upstreamArch: "aarch64",
    upstreamPlatform: "apple-darwin",
    archiveSha256: "62eef3fcf48fa4f792d0d6d267c140b81aaea0edca4ae0641d8021854314f966",
    archiveSize: 25_128_196,
  }),
  artifact({
    platform: "darwin",
    arch: "x64",
    upstreamArch: "x86_64",
    upstreamPlatform: "apple-darwin",
    archiveSha256: "65da7bc373ea36cb7e413f2a20bcced9eeb7e5a83fa554ce9f6ec79abb8d7e31",
    archiveSize: 24_824_201,
  }),
  artifact({
    platform: "linux",
    arch: "arm64",
    upstreamArch: "aarch64",
    upstreamPlatform: "unknown-linux-gnu",
    archiveSha256: "70162d3fa61a7bf52a9f098ad6f46046f9813ab50e0d2b3cfeb81ee1bad78f1c",
    archiveSize: 83_554_120,
  }),
  artifact({
    platform: "linux",
    arch: "x64",
    upstreamArch: "x86_64",
    upstreamPlatform: "unknown-linux-gnu",
    archiveSha256: "cbdd2f0cf02f941bc5c81e546f377275e322733abffe805ac29d2b7e8a58f7e3",
    archiveSize: 109_290_197,
  }),
];

export const PYTHON_RUNTIME_CAPSULES = Object.freeze(Object.fromEntries(
  CATALOG.map((item) => [item.runtime_id, item]),
));

export function getEvalRuntimeRoot(env = process.env) {
  if (typeof env?.AGENT_HUB_EVAL_RUNTIME_DIR === "string" && env.AGENT_HUB_EVAL_RUNTIME_DIR) {
    return path.resolve(env.AGENT_HUB_EVAL_RUNTIME_DIR);
  }
  const cacheHome = typeof env?.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME
    ? path.resolve(env.XDG_CACHE_HOME)
    : path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "agent-hub-mcp", "eval-runtimes");
}

export function pythonRuntimeSelftestEnvironment(env = process.env) {
  return {
    ...Object.fromEntries(
      SELFTEST_ENV_KEYS
        .filter((key) => typeof env?.[key] === "string")
        .map((key) => [key, env[key]]),
    ),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: "",
  };
}

export async function resolvePythonRuntimeCapsule(
  selector = "default",
  env = process.env,
  internal = {},
) {
  const selected = normalizeSelector(selector);
  let manifestPath;
  let selectedArtifact = null;
  let expectedContentDigest = null;
  if (path.isAbsolute(selected)) {
    manifestPath = path.resolve(selected);
    if (!await isRegularFile(manifestPath)) {
      throw capsuleError(
        "runtime_capsule_missing",
        `Python runtime capsule manifest is unavailable: ${manifestPath}`,
      );
    }
  } else {
    selectedArtifact = artifactForSelector(selected, internal);
    const installed = await installedManifestPath(selectedArtifact, env);
    manifestPath = installed.manifest_path;
    expectedContentDigest = installed.content_digest;
  }
  const runtime = await validatePythonRuntimeCapsuleManifest(manifestPath, env, internal);
  if (expectedContentDigest && runtime.content_digest !== expectedContentDigest) {
    throw capsuleError(
      "runtime_capsule_invalid",
      "Python runtime capsule object does not match its content-addressed reference",
    );
  }
  if (selectedArtifact) {
    assertRuntimeMatchesArtifact(runtime, selectedArtifact);
    await assertRuntimeObjectSealed(runtime);
    return { ...runtime, sealed: true };
  }
  if (internal.require_sealed) {
    await assertRuntimeObjectSealed(runtime);
    return { ...runtime, sealed: true };
  }
  return { ...runtime, sealed: false };
}

export async function pythonRuntimeCapsuleStatus(
  selector = "default",
  env = process.env,
  internal = {},
) {
  try {
    const runtime = await resolvePythonRuntimeCapsule(selector, env, internal);
    return { status: "ready", toolchain: runtimeToolchainSummary(runtime) };
  } catch (error) {
    const code = error?.code ?? "runtime_capsule_invalid";
    const status = code === "runtime_capsule_missing"
      ? "missing"
      : code === "runtime_capsule_unsupported"
        ? "unsupported"
        : "invalid";
    return {
      status,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function installPythonRuntimeCapsule(
  selector = "default",
  env = process.env,
  internal = {},
) {
  const selected = normalizeSelector(selector);
  if (path.isAbsolute(selected)) {
    throw capsuleError(
      "runtime_capsule_unsupported",
      "Python runtime capsule install accepts only default or a pinned runtime ID",
    );
  }
  const selectedArtifact = artifactForSelector(selected, internal);
  const storeRoot = getEvalRuntimeRoot(env);
  await ensurePrivateDirectory(storeRoot);

  try {
    const runtime = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, {
      ...internal,
      artifact: selectedArtifact,
    });
    return { status: "ready", toolchain: runtimeToolchainSummary(runtime) };
  } catch (error) {
    if (![
      "runtime_capsule_missing",
      "runtime_capsule_invalid",
      "runtime_capsule_unsupported",
    ].includes(error?.code)) throw error;
  }

  const installRoot = await fsp.mkdtemp(path.join(storeRoot, ".install-"));
  const archivePath = path.join(installRoot, "runtime.tar.gz");
  const stagedObject = path.join(installRoot, "object");
  let publishStaging = null;
  try {
    await downloadArtifact(selectedArtifact, archivePath, internal);
    const actualArchiveDigest = await sha256File(archivePath);
    if (`sha256:${actualArchiveDigest}` !== selectedArtifact.archive_sha256) {
      throw capsuleError(
        "runtime_capsule_download_failed",
        "Downloaded Python runtime capsule archive failed SHA-256 verification",
      );
    }
    const archiveStat = await fsp.stat(archivePath);
    if (
      Number.isSafeInteger(selectedArtifact.archive_size) &&
      archiveStat.size !== selectedArtifact.archive_size
    ) {
      throw capsuleError(
        "runtime_capsule_download_failed",
        "Downloaded Python runtime capsule archive has an unexpected size",
      );
    }

    const archiveEntries = await listArchiveEntries(archivePath, internal);
    validateArchiveEntries(archiveEntries, selectedArtifact.root);
    await fsp.mkdir(stagedObject, { mode: 0o700 });
    await extractArchive(archivePath, stagedObject, internal);
    await validateRuntimeTree(path.join(stagedObject, selectedArtifact.root));

    const manifestPath = await writePythonRuntimeCapsuleManifest(stagedObject, {
      runtime_id: selectedArtifact.runtime_id,
      python_version: selectedArtifact.python_version,
      platform: selectedArtifact.platform,
      arch: selectedArtifact.arch,
      root: selectedArtifact.root,
      commands: selectedArtifact.commands,
      source: {
        url: selectedArtifact.url,
        archive_sha256: selectedArtifact.archive_sha256,
      },
    });
    const stagedRuntime = await validatePythonRuntimeCapsuleManifest(manifestPath, env, {
      ...internal,
      platform: selectedArtifact.platform,
      arch: selectedArtifact.arch,
    });
    const digestHex = digestHexFromValue(stagedRuntime.content_digest, "content_digest");
    const objectParent = path.join(storeRoot, "objects", "sha256");
    const objectTarget = path.join(objectParent, digestHex);
    await ensurePrivateDirectory(objectParent);
    publishStaging = path.join(
      objectParent,
      `.stage-${digestHex}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`,
    );
    await fsp.rename(stagedObject, publishStaging);
    await sealRuntimeObject(
      publishStaging,
      path.join(publishStaging, selectedArtifact.root),
    );
    const publishRuntime = await validatePythonRuntimeCapsuleManifest(
      path.join(publishStaging, PYTHON_RUNTIME_MANIFEST_NAME),
      env,
      {
        ...internal,
        platform: selectedArtifact.platform,
        arch: selectedArtifact.arch,
      },
    );
    await assertRuntimeObjectSealed(publishRuntime);
    await runPythonRuntimeSelftest(publishRuntime, env, internal);
    let reuseExisting = false;
    if (await pathExists(objectTarget)) {
      try {
        const existing = await validatePythonRuntimeCapsuleManifest(
          path.join(objectTarget, PYTHON_RUNTIME_MANIFEST_NAME),
          env,
          internal,
        );
        assertRuntimeMatchesArtifact(existing, selectedArtifact);
        await assertRuntimeObjectSealed(existing);
        if (existing.content_digest !== publishRuntime.content_digest) {
          throw capsuleError(
            "runtime_capsule_invalid",
            "Runtime capsule content-addressed object is stored under the wrong digest",
          );
        }
        reuseExisting = true;
      } catch (error) {
        if (![
          "runtime_capsule_invalid",
          "runtime_capsule_missing",
          "runtime_capsule_unsupported",
        ].includes(error?.code)) {
          throw error;
        }
        await quarantineRuntimeObject(objectTarget, digestHex);
      }
    }
    if (!reuseExisting) {
      try {
        await fsp.rename(publishStaging, objectTarget);
        publishStaging = null;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
        const raced = await validatePythonRuntimeCapsuleManifest(
          path.join(objectTarget, PYTHON_RUNTIME_MANIFEST_NAME),
          env,
          internal,
        );
        assertRuntimeMatchesArtifact(raced, selectedArtifact);
        await assertRuntimeObjectSealed(raced);
        if (raced.content_digest !== publishRuntime.content_digest) {
          throw capsuleError(
            "runtime_capsule_invalid",
            "Concurrent runtime capsule install published a mismatched object",
          );
        }
      }
    }
    await publishRuntimeRef(storeRoot, selectedArtifact.runtime_id, digestHex);
    const installed = await resolvePythonRuntimeCapsule(selectedArtifact.runtime_id, env, {
      ...internal,
      artifact: selectedArtifact,
    });
    return { status: "ready", toolchain: runtimeToolchainSummary(installed) };
  } catch (error) {
    if (error?.code?.startsWith("runtime_capsule_")) throw error;
    throw capsuleError(
      "runtime_capsule_invalid",
      `Python runtime capsule installation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await makeRuntimeDirectoriesWritable(stagedObject).catch(() => undefined);
    if (publishStaging) {
      await makeRuntimeDirectoriesWritable(publishStaging).catch(() => undefined);
      await fsp.rm(publishStaging, { recursive: true, force: true }).catch(() => undefined);
    }
    await fsp.rm(installRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writePythonRuntimeCapsuleManifest(manifestDirectory, fields) {
  if (typeof manifestDirectory !== "string" || !path.isAbsolute(manifestDirectory)) {
    throw capsuleError(
      "runtime_capsule_invalid",
      "Runtime capsule manifest directory must be absolute",
    );
  }
  const realManifestDirectory = await fsp.realpath(manifestDirectory).catch(() => null);
  if (!realManifestDirectory || !(await fsp.stat(realManifestDirectory)).isDirectory()) {
    throw capsuleError(
      "runtime_capsule_invalid",
      "Runtime capsule manifest directory is unavailable",
    );
  }
  const normalized = normalizeManifestFields({
    kind: PYTHON_RUNTIME_CAPSULE_KIND,
    ...fields,
    content_digest: "sha256:" + "0".repeat(64),
  });
  const runtimeRoot = resolveRelativePath(realManifestDirectory, normalized.root, "root");
  await validateRuntimeTree(runtimeRoot);
  const commandPath = resolveRelativePath(
    runtimeRoot,
    normalized.commands.python3,
    "commands.python3",
  );
  await validateRuntimeCommand(runtimeRoot, commandPath);
  const treeDigest = await computeRuntimeTreeDigest(runtimeRoot);
  const contentDigest = runtimeCapsuleDigest(normalized, treeDigest);
  const manifest = { ...normalized, content_digest: contentDigest };
  const manifestPath = path.join(realManifestDirectory, PYTHON_RUNTIME_MANIFEST_NAME);
  await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return manifestPath;
}

export async function validatePythonRuntimeCapsuleManifest(
  manifestPath,
  env = process.env,
  internal = {},
) {
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule manifest path must be absolute");
  }
  const lexicalManifest = path.resolve(manifestPath);
  let stat;
  try {
    stat = await fsp.stat(lexicalManifest);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw capsuleError(
        "runtime_capsule_missing",
        `Python runtime capsule manifest is unavailable: ${lexicalManifest}`,
      );
    }
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule manifest must be a small file");
  }
  const canonicalManifest = await fsp.realpath(lexicalManifest);
  let document;
  try {
    document = JSON.parse(await fsp.readFile(canonicalManifest, "utf8"));
  } catch (error) {
    throw capsuleError(
      "runtime_capsule_invalid",
      `Runtime capsule manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = normalizeManifestFields(document);
  const expectedPlatform = internal.platform ?? process.platform;
  const expectedArch = internal.arch ?? process.arch;
  if (manifest.platform !== expectedPlatform || manifest.arch !== expectedArch) {
    throw capsuleError(
      "runtime_capsule_unsupported",
      `Python runtime capsule targets ${manifest.platform}/${manifest.arch}, not ` +
        `${expectedPlatform}/${expectedArch}`,
    );
  }

  const manifestDirectory = path.dirname(canonicalManifest);
  const runtimeRoot = resolveRelativePath(manifestDirectory, manifest.root, "root");
  const rootLstat = await fsp.lstat(runtimeRoot).catch(() => null);
  if (!rootLstat?.isDirectory() || rootLstat.isSymbolicLink()) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule root must be a directory");
  }
  const canonicalRoot = await fsp.realpath(runtimeRoot);
  if (canonicalRoot !== runtimeRoot) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule root must be canonical");
  }
  if (await includesUnsafeRoot([canonicalRoot], env)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule root is too broad");
  }
  const forbiddenRoots = await normalizeForbiddenRoots(internal.forbidden_roots);
  if (await overlapsForbiddenRoot(canonicalRoot, forbiddenRoots)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule overlaps a forbidden root");
  }
  await validateRuntimeTree(canonicalRoot);
  const treeDigest = await computeRuntimeTreeDigest(canonicalRoot);
  const actualDigest = runtimeCapsuleDigest(manifest, treeDigest);
  if (actualDigest !== manifest.content_digest) {
    throw capsuleError(
      "runtime_capsule_invalid",
      "Python runtime capsule content digest does not match its manifest",
    );
  }
  const python3 = resolveRelativePath(
    canonicalRoot,
    manifest.commands.python3,
    "commands.python3",
  );
  const canonicalPython = await validateRuntimeCommand(canonicalRoot, python3);
  return {
    ...manifest,
    manifest_path: canonicalManifest,
    root: canonicalRoot,
    commands: { python3: canonicalPython },
    read_paths: [canonicalRoot],
  };
}

export async function computeRuntimeTreeDigest(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule digest root must be absolute");
  }
  const lexicalRoot = path.resolve(root);
  const rootStat = await fsp.lstat(lexicalRoot).catch(() => null);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule digest root must be a directory");
  }
  const canonicalRoot = await fsp.realpath(lexicalRoot);
  const digest = crypto.createHash("sha256");
  digest.update("agent-hub-python-runtime-tree-v1\0");
  let entryCount = 0;
  let totalBytes = 0;

  async function visit(directory, relativeDirectory = "") {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_TREE_ENTRIES) {
        throw capsuleError("runtime_capsule_invalid", "Runtime capsule contains too many entries");
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        hashTreeField(digest, "directory", relative, "");
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_TREE_BYTES) {
          throw capsuleError("runtime_capsule_invalid", "Runtime capsule content is too large");
        }
        hashTreeField(digest, "file", relative, `${stat.mode & 0o100 ? "x" : "-"}:${stat.size}`);
        const handle = await fsp.open(absolute, "r");
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            digest.update(chunk);
          }
        } finally {
          await handle.close();
        }
      } else if (stat.isSymbolicLink()) {
        const target = await validateRuntimeSymlink(canonicalRoot, absolute);
        hashTreeField(digest, "symlink", relative, target);
      } else {
        throw capsuleError(
          "runtime_capsule_invalid",
          `Runtime capsule contains a special file: ${relative}`,
        );
      }
    }
  }

  await visit(canonicalRoot);
  return `sha256:${digest.digest("hex")}`;
}

function runtimeCapsuleDigest(manifest, treeDigest) {
  const identity = {
    kind: manifest.kind,
    runtime_id: manifest.runtime_id,
    python_version: manifest.python_version,
    platform: manifest.platform,
    arch: manifest.arch,
    root: manifest.root,
    commands: { python3: manifest.commands.python3 },
    source: manifest.source
      ? {
          url: manifest.source.url,
          archive_sha256: manifest.source.archive_sha256,
        }
      : null,
    tree_digest: treeDigest,
  };
  return `sha256:${crypto.createHash("sha256").update(
    "agent-hub-python-runtime-capsule-v1\0",
  ).update(JSON.stringify(identity)).digest("hex")}`;
}

export function parsePythonRuntimeSelftest(stdout, expected = {}) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_MANIFEST_BYTES) {
    throw capsuleError("runtime_capsule_selftest_failed", "Python runtime self-test output is invalid");
  }
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw capsuleError("runtime_capsule_selftest_failed", "Python runtime self-test output is invalid");
  }
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const expectedKeys = ["base_prefix", "checks", "executable", "prefix", "python_version"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw capsuleError("runtime_capsule_selftest_failed", "Python runtime self-test output is invalid");
  }
  for (const key of ["executable", "prefix", "base_prefix"]) {
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key])) {
      throw capsuleError("runtime_capsule_selftest_failed", "Python runtime self-test output is invalid");
    }
  }
  if (
    typeof value.python_version !== "string" ||
    (expected.python_version && value.python_version !== expected.python_version) ||
    JSON.stringify(value.checks) !== JSON.stringify(SELFTEST_CHECKS)
  ) {
    throw capsuleError("runtime_capsule_selftest_failed", "Python runtime self-test output is invalid");
  }
  return {
    executable: path.resolve(value.executable),
    prefix: path.resolve(value.prefix),
    base_prefix: path.resolve(value.base_prefix),
    python_version: value.python_version,
    checks: [...value.checks],
  };
}

export async function validatePythonRuntimeSelftest(stdout, runtime) {
  const reported = parsePythonRuntimeSelftest(stdout, runtime);
  const actualExecutable = await fsp.realpath(reported.executable).catch(() => null);
  if (!actualExecutable || actualExecutable !== runtime.commands.python3) {
    throw capsuleError(
      "runtime_capsule_selftest_failed",
      "Python runtime self-test used an unexpected executable",
    );
  }
  for (const key of ["prefix", "base_prefix"]) {
    const actual = await fsp.realpath(reported[key]).catch(() => null);
    if (!actual || !pathIsInside(actual, runtime.root)) {
      throw capsuleError(
        "runtime_capsule_selftest_failed",
        `Python runtime self-test reported ${key} outside the capsule`,
      );
    }
  }
  return reported;
}

export async function createRuntimeCommandBin(parent, commands) {
  if (typeof parent !== "string" || !path.isAbsolute(parent)) {
    throw new Error("Runtime command-bin parent must be an absolute directory");
  }
  const realParent = await fsp.realpath(parent);
  const parentStat = await fsp.stat(realParent);
  if (!parentStat.isDirectory()) {
    throw new Error("Runtime command-bin parent must be a directory");
  }
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    throw new Error("Runtime commands must be a non-empty object");
  }
  const entries = Object.entries(commands);
  if (entries.length === 0) {
    throw new Error("Runtime commands must be a non-empty object");
  }

  const normalized = [];
  for (const [name, executable] of entries) {
    if (!COMMAND_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid runtime command name: ${JSON.stringify(name)}`);
    }
    if (typeof executable !== "string" || !path.isAbsolute(executable)) {
      throw new Error(`Runtime command ${name} must use an absolute executable`);
    }
    const absolute = path.resolve(executable);
    if (!await isExecutableFile(absolute)) {
      throw new Error(`Runtime command ${name} executable is unavailable`);
    }
    const canonical = await fsp.realpath(absolute);
    if (!await isExecutableFile(canonical)) {
      throw new Error(`Runtime command ${name} executable is unavailable`);
    }
    normalized.push([name, canonical]);
  }

  const commandBin = path.join(realParent, "runtime-bin");
  await fsp.mkdir(commandBin, { mode: 0o700 });
  try {
    await fsp.chmod(commandBin, 0o700);
    for (const [name, executable] of normalized) {
      await fsp.symlink(executable, path.join(commandBin, name));
    }
    await fsp.chmod(commandBin, 0o555);
    return await fsp.realpath(commandBin);
  } catch (error) {
    await fsp.chmod(commandBin, 0o700).catch(() => undefined);
    await fsp.rm(commandBin, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeSelector(value) {
  if (value === undefined || value === null || value === "") return "default";
  if (typeof value !== "string" || value.trim() !== value || value.includes("\0")) {
    throw capsuleError("runtime_capsule_unsupported", "Runtime capsule selector is invalid");
  }
  if (value === "default" || path.isAbsolute(value)) return value;
  if (!RUNTIME_ID_PATTERN.test(value)) {
    throw capsuleError("runtime_capsule_unsupported", "Runtime capsule selector is invalid");
  }
  return value;
}

function artifactForSelector(selector, internal) {
  const platform = internal.platform ?? process.platform;
  const arch = internal.arch ?? process.arch;
  const injected = internal.artifact;
  if (injected && (selector === "default" || selector === injected.runtime_id)) {
    const selected = normalizeArtifact(injected);
    assertArtifactTargetsHost(selected, platform, arch);
    return selected;
  }
  const selected = selector === "default"
    ? CATALOG.find((item) => item.platform === platform && item.arch === arch)
    : PYTHON_RUNTIME_CAPSULES[selector];
  if (!selected) {
    const detail = selector === "default" ? `${platform}/${arch}` : selector;
    throw capsuleError(
      "runtime_capsule_unsupported",
      `No pinned Python runtime capsule is available for ${detail}`,
    );
  }
  assertArtifactTargetsHost(selected, platform, arch);
  return selected;
}

function assertArtifactTargetsHost(selected, platform, arch) {
  if (selected.platform !== platform || selected.arch !== arch) {
    throw capsuleError(
      "runtime_capsule_unsupported",
      `Python runtime capsule ${selected.runtime_id} targets ` +
        `${selected.platform}/${selected.arch}, not ${platform}/${arch}`,
    );
  }
}

function assertRuntimeMatchesArtifact(runtime, selected) {
  const source = runtime.source;
  if (
    runtime.runtime_id !== selected.runtime_id ||
    runtime.python_version !== selected.python_version ||
    runtime.platform !== selected.platform ||
    runtime.arch !== selected.arch ||
    !source ||
    source.url !== selected.url ||
    source.archive_sha256 !== selected.archive_sha256
  ) {
    throw capsuleError(
      "runtime_capsule_invalid",
      "Installed Python runtime capsule does not match its pinned artifact",
    );
  }
}

function normalizeArtifact(value) {
  const required = [
    "runtime_id", "python_version", "platform", "arch", "url",
    "archive_sha256", "archive_size", "root", "commands",
  ];
  if (!value || typeof value !== "object" || required.some((key) => !(key in value))) {
    throw capsuleError("runtime_capsule_unsupported", "Pinned runtime artifact is invalid");
  }
  if (!RUNTIME_ID_PATTERN.test(value.runtime_id)) {
    throw capsuleError("runtime_capsule_unsupported", "Pinned runtime artifact is invalid");
  }
  digestHexFromValue(value.archive_sha256, "archive_sha256");
  if (!Number.isSafeInteger(value.archive_size) || value.archive_size <= 0) {
    throw capsuleError("runtime_capsule_unsupported", "Pinned runtime artifact is invalid");
  }
  const url = validHttpsUrl(value.url, "artifact URL");
  relativeCapsulePath(value.root, "root");
  relativeCapsulePath(value.commands?.python3, "commands.python3");
  return { ...value, url };
}

async function installedManifestPath(selectedArtifact, env) {
  const storeRoot = getEvalRuntimeRoot(env);
  const refPath = path.join(storeRoot, "refs", selectedArtifact.runtime_id);
  let digestHex;
  try {
    digestHex = (await fsp.readFile(refPath, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw capsuleError(
        "runtime_capsule_missing",
        `Python runtime capsule is not installed: ${selectedArtifact.runtime_id}`,
      );
    }
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(digestHex)) {
    throw capsuleError("runtime_capsule_invalid", "Python runtime capsule reference is invalid");
  }
  const manifestPath = path.join(
    storeRoot, "objects", "sha256", digestHex, PYTHON_RUNTIME_MANIFEST_NAME,
  );
  if (!await isRegularFile(manifestPath)) {
    throw capsuleError("runtime_capsule_invalid", "Python runtime capsule object is unavailable");
  }
  return {
    manifest_path: manifestPath,
    content_digest: `sha256:${digestHex}`,
  };
}

function normalizeManifestFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule manifest must be an object");
  }
  const allowed = new Set([
    "kind", "runtime_id", "python_version", "platform", "arch", "root",
    "commands", "content_digest", "source",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule manifest has unknown fields");
  }
  if (value.kind !== PYTHON_RUNTIME_CAPSULE_KIND) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule manifest kind is unsupported");
  }
  if (typeof value.runtime_id !== "string" || !RUNTIME_ID_PATTERN.test(value.runtime_id)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule runtime_id is invalid");
  }
  if (
    typeof value.python_version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.test(
      value.python_version,
    )
  ) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule python_version is invalid");
  }
  if (!["darwin", "linux"].includes(value.platform)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule platform is invalid");
  }
  if (!["arm64", "x64"].includes(value.arch)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule arch is invalid");
  }
  const root = relativeCapsulePath(value.root, "root");
  if (
    !value.commands || typeof value.commands !== "object" || Array.isArray(value.commands) ||
    JSON.stringify(Object.keys(value.commands).sort()) !== JSON.stringify(["python3"])
  ) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule commands are invalid");
  }
  const python3 = relativeCapsulePath(value.commands.python3, "commands.python3");
  digestHexFromValue(value.content_digest, "content_digest");
  let source;
  if (value.source !== undefined) {
    if (
      !value.source || typeof value.source !== "object" || Array.isArray(value.source) ||
      JSON.stringify(Object.keys(value.source).sort()) !==
        JSON.stringify(["archive_sha256", "url"])
    ) {
      throw capsuleError("runtime_capsule_invalid", "Runtime capsule source is invalid");
    }
    source = {
      url: validHttpsUrl(value.source.url, "source URL"),
      archive_sha256: `sha256:${digestHexFromValue(
        value.source.archive_sha256,
        "source.archive_sha256",
      )}`,
    };
  }
  return {
    kind: value.kind,
    runtime_id: value.runtime_id,
    python_version: value.python_version,
    platform: value.platform,
    arch: value.arch,
    root,
    commands: { python3 },
    content_digest: `sha256:${digestHexFromValue(value.content_digest, "content_digest")}`,
    ...(source ? { source } : {}),
  };
}

function relativeCapsulePath(value, label) {
  if (
    typeof value !== "string" || value === "" || value.includes("\0") ||
    value.includes("\\") || path.posix.isAbsolute(value)
  ) {
    throw capsuleError("runtime_capsule_invalid", `Runtime capsule ${label} must be relative`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." || normalized === ".." || normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw capsuleError("runtime_capsule_invalid", `Runtime capsule ${label} must be normalized`);
  }
  return normalized;
}

function resolveRelativePath(root, relative, label) {
  const resolved = path.resolve(root, ...relative.split("/"));
  if (!pathIsInside(resolved, root)) {
    throw capsuleError("runtime_capsule_invalid", `Runtime capsule ${label} escapes its root`);
  }
  return resolved;
}

async function validateRuntimeTree(root) {
  const lexicalRoot = path.resolve(root);
  const rootStat = await fsp.lstat(lexicalRoot).catch(() => null);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule root must be a directory");
  }
  const canonicalRoot = await fsp.realpath(lexicalRoot);
  let entriesSeen = 0;
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      entriesSeen += 1;
      if (entriesSeen > MAX_TREE_ENTRIES) {
        throw capsuleError("runtime_capsule_invalid", "Runtime capsule contains too many entries");
      }
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(absolute);
      } else if (stat.isFile()) {
        continue;
      } else if (stat.isSymbolicLink()) {
        await validateRuntimeSymlink(canonicalRoot, absolute);
      } else {
        const relative = path.relative(canonicalRoot, absolute);
        throw capsuleError(
          "runtime_capsule_invalid",
          `Runtime capsule contains a special file: ${relative}`,
        );
      }
    }
  }
  await visit(canonicalRoot);
}

async function validateRuntimeSymlink(root, symlink) {
  const target = await fsp.readlink(symlink);
  if (path.isAbsolute(target)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule contains an absolute symlink");
  }
  const lexicalTarget = path.resolve(path.dirname(symlink), target);
  if (!pathIsInside(lexicalTarget, root)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule symlink escapes its root");
  }
  const canonicalTarget = await fsp.realpath(symlink).catch(() => null);
  if (!canonicalTarget || !pathIsInside(canonicalTarget, root)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule contains an unsafe symlink");
  }
  return target;
}

async function validateRuntimeCommand(root, command) {
  if (!await isExecutableFile(command)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule python3 command is unavailable");
  }
  const canonical = await fsp.realpath(command);
  if (!pathIsInside(canonical, root)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule python3 command escapes its root");
  }
  return canonical;
}

async function runPythonRuntimeSelftest(runtime, env, internal) {
  const commandRunner = internal.run_command ?? runCommand;
  const result = await commandRunner(runtime.commands.python3, PYTHON_RUNTIME_SELFTEST_ARGS, {
    env: pythonRuntimeSelftestEnvironment(env),
    timeoutMs: internal.selftest_timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_MANIFEST_BYTES,
  });
  if (result?.error || result?.code !== 0) {
    throw capsuleError(
      "runtime_capsule_selftest_failed",
      "Python runtime capsule failed its native standard-library self-test",
    );
  }
  await validatePythonRuntimeSelftest(result.stdout, runtime);
}

async function downloadArtifact(selectedArtifact, target, internal) {
  if (typeof internal.download_file === "function") {
    await internal.download_file(selectedArtifact, target);
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    internal.download_timeout_ms ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
  );
  let handle;
  try {
    const response = await fetch(selectedArtifact.url, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    handle = await fsp.open(target, "wx", 0o600);
    const reader = response.body.getReader();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > selectedArtifact.archive_size) {
        throw new Error("archive exceeded its pinned size");
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten <= 0) throw new Error("archive write made no progress");
        offset += bytesWritten;
      }
    }
    if (bytes !== selectedArtifact.archive_size) {
      throw new Error("archive did not match its pinned size");
    }
  } catch (error) {
    throw capsuleError(
      "runtime_capsule_download_failed",
      `Python runtime capsule download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => undefined);
  }
}

async function listArchiveEntries(archivePath, internal) {
  if (typeof internal.list_archive === "function") return internal.list_archive(archivePath);
  const tar = await systemTar();
  const commandRunner = internal.archive_run_command ?? runCommand;
  const result = await commandRunner(tar, ["-tzf", archivePath], {
    env: archiveToolEnvironment(),
    timeoutMs: internal.archive_timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_ARCHIVE_LIST_BYTES,
  });
  if (result.error || result.code !== 0) {
    throw capsuleError("runtime_capsule_invalid", "Python runtime capsule archive could not be listed");
  }
  return result.stdout.split("\n").filter(Boolean);
}

function validateArchiveEntries(entries, expectedRoot) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw capsuleError("runtime_capsule_invalid", "Python runtime capsule archive listing is invalid");
  }
  let sawRoot = false;
  for (const entry of entries) {
    if (typeof entry !== "string" || entry === "" || entry.includes("\0") || entry.includes("\\")) {
      throw capsuleError("runtime_capsule_invalid", "Python runtime capsule archive path is invalid");
    }
    const withoutDot = entry.startsWith("./") ? entry.slice(2) : entry;
    const withoutSlash = withoutDot.replace(/\/$/, "");
    if (
      !withoutSlash || path.posix.isAbsolute(withoutSlash) ||
      path.posix.normalize(withoutSlash) !== withoutSlash || withoutSlash === ".." ||
      withoutSlash.startsWith("../")
    ) {
      throw capsuleError("runtime_capsule_invalid", "Python runtime capsule archive path is unsafe");
    }
    if (withoutSlash !== expectedRoot && !withoutSlash.startsWith(`${expectedRoot}/`)) {
      throw capsuleError("runtime_capsule_invalid", "Python runtime capsule archive has an unexpected root");
    }
    sawRoot = true;
  }
  if (!sawRoot) {
    throw capsuleError("runtime_capsule_invalid", "Python runtime capsule archive root is missing");
  }
}

async function extractArchive(archivePath, destination, internal) {
  if (typeof internal.extract_archive === "function") {
    await internal.extract_archive(archivePath, destination);
    return;
  }
  const tar = await systemTar();
  const commandRunner = internal.archive_run_command ?? runCommand;
  const result = await commandRunner(tar, [
    "-xzf", archivePath, "-C", destination, "--no-same-owner", "--no-same-permissions",
  ], {
    env: archiveToolEnvironment(),
    timeoutMs: internal.archive_timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.error || result.code !== 0) {
    throw capsuleError("runtime_capsule_invalid", "Python runtime capsule archive extraction failed");
  }
}

function archiveToolEnvironment() {
  return {
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    PATH: "/usr/bin:/bin",
  };
}

async function systemTar() {
  for (const candidate of ["/usr/bin/tar", "/bin/tar"]) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  throw capsuleError("runtime_capsule_unsupported", "A system tar implementation is required");
}

async function publishRuntimeRef(storeRoot, runtimeId, digestHex) {
  const refs = path.join(storeRoot, "refs");
  await ensurePrivateDirectory(refs);
  await atomicWriteFile(path.join(refs, runtimeId), `${digestHex}\n`, 0o600);
}

async function quarantineRuntimeObject(objectTarget, digestHex) {
  const objectParent = path.dirname(objectTarget);
  const quarantineTarget = path.join(
    objectParent,
    `.invalid-${digestHex}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}`,
  );
  try {
    await fsp.rename(objectTarget, quarantineTarget);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return quarantineTarget;
}

async function sealRuntimeObject(objectRoot, runtimeRoot) {
  const objectStat = await fsp.lstat(objectRoot).catch(() => null);
  const rootStat = await fsp.lstat(runtimeRoot).catch(() => null);
  if (
    !objectStat?.isDirectory() || objectStat.isSymbolicLink() ||
    !rootStat?.isDirectory() || rootStat.isSymbolicLink() ||
    !pathIsInside(await fsp.realpath(runtimeRoot), await fsp.realpath(objectRoot))
  ) {
    throw capsuleError("runtime_capsule_invalid", "Runtime capsule publish path is unsafe");
  }
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
  await visit(runtimeRoot);
  await fsp.chmod(runtimeRoot, 0o555);
  await fsp.chmod(path.join(objectRoot, PYTHON_RUNTIME_MANIFEST_NAME), 0o444);
  await fsp.chmod(objectRoot, 0o555);
}

async function assertRuntimeObjectSealed(runtime) {
  for (const target of [path.dirname(runtime.manifest_path), runtime.manifest_path]) {
    const stat = await fsp.lstat(target);
    if (stat.mode & 0o222) {
      throw capsuleError("runtime_capsule_invalid", "Installed runtime capsule is not sealed");
    }
  }
  async function visit(directory) {
    const directoryStat = await fsp.lstat(directory);
    if (directoryStat.mode & 0o222) {
      throw capsuleError("runtime_capsule_invalid", "Installed runtime capsule is not sealed");
    }
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(target);
      } else if (stat.isFile() && (stat.mode & 0o222)) {
        throw capsuleError("runtime_capsule_invalid", "Installed runtime capsule is not sealed");
      }
    }
  }
  await visit(runtime.root);
}

async function makeRuntimeDirectoriesWritable(root) {
  const stat = await fsp.lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  await fsp.chmod(root, 0o700);
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeRuntimeDirectoriesWritable(path.join(root, entry.name));
    }
  }
}

function runtimeToolchainSummary(runtime) {
  return {
    kind: runtime.kind,
    runtime_id: runtime.runtime_id,
    python_version: runtime.python_version,
    content_digest: runtime.content_digest,
    platform: runtime.platform,
    arch: runtime.arch,
  };
}

async function ensurePrivateDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => undefined);
}

async function atomicWriteFile(target, value, mode) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await fsp.writeFile(temporary, value, { flag: "wx", mode });
    await fsp.rename(temporary, target);
    await fsp.chmod(target, mode).catch(() => undefined);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function sha256File(file) {
  const digest = crypto.createHash("sha256");
  const handle = await fsp.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

function hashTreeField(digest, type, relative, metadata) {
  for (const value of [type, relative, metadata]) {
    const bytes = Buffer.from(value, "utf8");
    digest.update(String(bytes.length));
    digest.update(":");
    digest.update(bytes);
  }
  digest.update("\0");
}

function digestHexFromValue(value, label) {
  const match = typeof value === "string" ? value.match(SHA256_PATTERN) : null;
  if (!match) {
    throw capsuleError("runtime_capsule_invalid", `Runtime capsule ${label} must be a SHA-256 digest`);
  }
  return match[1];
}

function validHttpsUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("unsafe URL");
    return parsed.href;
  } catch {
    throw capsuleError("runtime_capsule_invalid", `Runtime capsule ${label} must be HTTPS`);
  }
}

async function isRegularFile(value) {
  try {
    return (await fsp.stat(value)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  try {
    await fsp.access(value, fsConstants.X_OK);
    return (await fsp.stat(value)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function includesUnsafeRoot(readPaths, env) {
  const homes = new Set();
  const configuredHome = env?.HOME ?? os.homedir();
  if (typeof configuredHome === "string" && configuredHome) {
    const lexicalHome = path.resolve(configuredHome);
    homes.add(lexicalHome);
    homes.add(await fsp.realpath(lexicalHome).catch(() => lexicalHome));
  }
  return readPaths.some((item) => {
    const resolved = path.resolve(item);
    return resolved === path.parse(resolved).root || homes.has(resolved) ||
      Array.from(homes).some((home) => pathIsInside(home, resolved));
  });
}

async function normalizeForbiddenRoots(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw capsuleError("runtime_capsule_invalid", "Runtime forbidden roots must be an array");
  }
  const roots = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !path.isAbsolute(item)) {
      throw capsuleError(
        "runtime_capsule_invalid",
        `Runtime forbidden root ${index} must be absolute`,
      );
    }
    const lexical = path.resolve(item);
    roots.add(lexical);
    roots.add(await fsp.realpath(lexical).catch(() => lexical));
  }
  return Array.from(roots);
}

async function overlapsForbiddenRoot(candidate, forbiddenRoots) {
  if (forbiddenRoots.length === 0) return false;
  const lexical = path.resolve(candidate);
  const real = await fsp.realpath(lexical).catch(() => lexical);
  return [lexical, real].some((item) =>
    forbiddenRoots.some((root) => pathIsInside(item, root) || pathIsInside(root, item)),
  );
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function capsuleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

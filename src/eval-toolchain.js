import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EVAL_TOOLCHAIN_CAPSULE_KIND = "eval-toolchain-capsule/v1";
export const EVAL_TOOLCHAIN_MANIFEST_NAME = "manifest.json";

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOLCHAIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;

export async function writeEvalToolchainCapsuleManifest(manifestDirectory, fields) {
  if (typeof manifestDirectory !== "string" || !path.isAbsolute(manifestDirectory)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest directory must be absolute",
    );
  }
  const realManifestDirectory = await fsp.realpath(manifestDirectory).catch(() => null);
  const directoryStat = realManifestDirectory
    ? await fsp.lstat(realManifestDirectory).catch(() => null)
    : null;
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest directory is unavailable",
    );
  }
  if (await includesUnsafeRoot([realManifestDirectory], process.env)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest directory is too broad",
    );
  }

  const normalized = normalizeManifestFields({
    kind: EVAL_TOOLCHAIN_CAPSULE_KIND,
    ...fields,
    content_digest: "sha256:" + "0".repeat(64),
  });
  const toolchainRoot = resolveRelativePath(realManifestDirectory, normalized.root, "root");
  const canonicalRoot = await validateCanonicalRoot(toolchainRoot);
  if (await includesUnsafeRoot([canonicalRoot], process.env)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule root is too broad",
    );
  }
  const treeDigest = await computeEvalToolchainTreeDigest(canonicalRoot);
  await resolveCommands(canonicalRoot, normalized.commands);
  const contentDigest = evalToolchainCapsuleDigest(normalized, treeDigest);
  const manifest = { ...normalized, content_digest: contentDigest };
  const manifestPath = path.join(realManifestDirectory, EVAL_TOOLCHAIN_MANIFEST_NAME);
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestContents, "utf8") > MAX_MANIFEST_BYTES) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest must be a small regular file",
    );
  }
  await atomicWriteFile(manifestPath, manifestContents, 0o600);
  return manifestPath;
}

export async function resolveEvalToolchainCapsule(
  selector,
  env = process.env,
  options = {},
) {
  if (
    typeof selector !== "string" || selector.trim() !== selector ||
    selector.includes("\0") || !path.isAbsolute(selector)
  ) {
    throw toolchainError(
      "toolchain_capsule_unsupported",
      "Eval toolchain capsules require an absolute manifest path",
    );
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw toolchainError("toolchain_capsule_invalid", "Eval toolchain capsule options are invalid");
  }
  if (options.require_sealed !== undefined && typeof options.require_sealed !== "boolean") {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule require_sealed option must be boolean",
    );
  }

  const lexicalManifest = path.resolve(selector);
  let manifestStat;
  try {
    manifestStat = await fsp.lstat(lexicalManifest);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw toolchainError(
        "toolchain_capsule_missing",
        `Eval toolchain capsule manifest is unavailable: ${lexicalManifest}`,
      );
    }
    throw error;
  }
  if (
    !manifestStat.isFile() || manifestStat.isSymbolicLink() ||
    manifestStat.nlink !== 1 || manifestStat.size > MAX_MANIFEST_BYTES
  ) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest must be a small regular file",
    );
  }

  const canonicalManifest = await fsp.realpath(lexicalManifest);
  const forbiddenRoots = await normalizeForbiddenRoots(options.forbidden_roots);
  const manifestDirectories = [path.dirname(lexicalManifest), path.dirname(canonicalManifest)];
  if (await includesUnsafeRoot(manifestDirectories, env)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest directory is too broad",
    );
  }
  if (
    await overlapsForbiddenRoot(lexicalManifest, forbiddenRoots) ||
    await overlapsForbiddenRoot(canonicalManifest, forbiddenRoots)
  ) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest overlaps a forbidden root",
    );
  }

  let document;
  try {
    document = JSON.parse(await fsp.readFile(canonicalManifest, "utf8"));
  } catch (error) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      `Eval toolchain capsule manifest is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const manifest = normalizeManifestFields(document);
  const expectedPlatform = options.platform ?? process.platform;
  const expectedArch = options.arch ?? process.arch;
  if (manifest.platform !== expectedPlatform || manifest.arch !== expectedArch) {
    throw toolchainError(
      "toolchain_capsule_unsupported",
      `Eval toolchain capsule targets ${manifest.platform}/${manifest.arch}, not ` +
        `${expectedPlatform}/${expectedArch}`,
    );
  }

  const lexicalRoot = resolveRelativePath(
    path.dirname(canonicalManifest),
    manifest.root,
    "root",
  );
  const canonicalRoot = await validateCanonicalRoot(lexicalRoot);
  if (await includesUnsafeRoot([lexicalRoot, canonicalRoot], env)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule root is too broad",
    );
  }
  if (
    await overlapsForbiddenRoot(lexicalRoot, forbiddenRoots) ||
    await overlapsForbiddenRoot(canonicalRoot, forbiddenRoots)
  ) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule root overlaps a forbidden root",
    );
  }

  const treeDigest = await computeEvalToolchainTreeDigest(canonicalRoot);
  const actualDigest = evalToolchainCapsuleDigest(manifest, treeDigest);
  if (actualDigest !== manifest.content_digest) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule content digest does not match its manifest",
    );
  }
  const commands = await resolveCommands(canonicalRoot, manifest.commands);
  const resolved = {
    ...manifest,
    root: canonicalRoot,
    commands,
    read_paths: [canonicalRoot],
    manifest_path: canonicalManifest,
    sealed: false,
  };
  if (options.require_sealed) {
    await assertToolchainCapsuleSealed(resolved);
    return { ...resolved, sealed: true };
  }
  return resolved;
}

export async function evalToolchainCapsuleStatus(
  selector,
  env = process.env,
  options = {},
) {
  try {
    const toolchain = await resolveEvalToolchainCapsule(selector, env, options);
    return {
      status: "ready",
      toolchain: {
        kind: toolchain.kind,
        toolchain_id: toolchain.toolchain_id,
        content_digest: toolchain.content_digest,
        platform: toolchain.platform,
        arch: toolchain.arch,
        commands: Object.keys(toolchain.commands).sort(),
      },
    };
  } catch (error) {
    const code = error?.code === "toolchain_capsule_missing" ||
      error?.code === "toolchain_capsule_unsupported" ||
      error?.code === "toolchain_capsule_invalid"
      ? error.code
      : "toolchain_capsule_invalid";
    const status = code === "toolchain_capsule_missing"
      ? "missing"
      : code === "toolchain_capsule_unsupported"
        ? "unsupported"
        : "invalid";
    return {
      status,
      error: {
        code,
        message: status === "missing"
          ? "Eval toolchain capsule is unavailable"
          : status === "unsupported"
            ? "Eval toolchain capsule is unsupported"
            : "Eval toolchain capsule is invalid",
      },
    };
  }
}

export async function computeEvalToolchainTreeDigest(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule digest root must be absolute",
    );
  }
  const lexicalRoot = path.resolve(root);
  const rootStat = await fsp.lstat(lexicalRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule digest root must be a directory",
    );
  }
  const canonicalRoot = await fsp.realpath(lexicalRoot);
  const digest = crypto.createHash("sha256");
  digest.update("agent-hub-eval-toolchain-tree-v1\0");
  let entryCount = 0;
  let totalBytes = 0;

  async function visit(directory, relativeDirectory = "") {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_TREE_ENTRIES) {
        throw toolchainError(
          "toolchain_capsule_invalid",
          "Eval toolchain capsule contains too many entries",
        );
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        hashTreeField(digest, "directory", relative, "");
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) {
          throw toolchainError(
            "toolchain_capsule_invalid",
            `Eval toolchain capsule contains a multiply-linked file: ${relative}`,
          );
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_TREE_BYTES) {
          throw toolchainError(
            "toolchain_capsule_invalid",
            "Eval toolchain capsule content is too large",
          );
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
        const target = await validateToolchainSymlink(canonicalRoot, absolute);
        hashTreeField(digest, "symlink", relative, target);
      } else {
        throw toolchainError(
          "toolchain_capsule_invalid",
          `Eval toolchain capsule contains a special file: ${relative}`,
        );
      }
    }
  }

  await visit(canonicalRoot);
  return `sha256:${digest.digest("hex")}`;
}

function normalizeManifestFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest must be an object",
    );
  }
  const allowed = new Set([
    "kind", "toolchain_id", "platform", "arch", "root", "commands", "content_digest",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest has unknown fields",
    );
  }
  if (value.kind !== EVAL_TOOLCHAIN_CAPSULE_KIND) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule manifest kind is unsupported",
    );
  }
  if (typeof value.toolchain_id !== "string" || !TOOLCHAIN_ID_PATTERN.test(value.toolchain_id)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule toolchain_id is invalid",
    );
  }
  if (!["darwin", "linux"].includes(value.platform)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule platform is invalid",
    );
  }
  if (!["arm64", "x64"].includes(value.arch)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule arch is invalid",
    );
  }
  const root = relativeToolchainPath(value.root, "root");
  if (!value.commands || typeof value.commands !== "object" || Array.isArray(value.commands)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule commands must be a non-empty object",
    );
  }
  const entries = Object.entries(value.commands);
  if (entries.length === 0) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule commands must be a non-empty object",
    );
  }
  const commands = {};
  for (const [name, commandPath] of entries.sort(compareCommandEntries)) {
    if (!COMMAND_NAME_PATTERN.test(name)) {
      throw toolchainError(
        "toolchain_capsule_invalid",
        `Eval toolchain capsule command name is invalid: ${JSON.stringify(name)}`,
      );
    }
    commands[name] = relativeToolchainPath(commandPath, `commands.${name}`);
  }
  digestHexFromValue(value.content_digest, "content_digest");
  return {
    kind: value.kind,
    toolchain_id: value.toolchain_id,
    platform: value.platform,
    arch: value.arch,
    root,
    commands,
    content_digest: value.content_digest,
  };
}

function relativeToolchainPath(value, label) {
  if (
    typeof value !== "string" || value === "" || value.includes("\0") ||
    value.includes("\\") || path.posix.isAbsolute(value)
  ) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      `Eval toolchain capsule ${label} must be relative`,
    );
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." || normalized === ".." || normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      `Eval toolchain capsule ${label} must be normalized`,
    );
  }
  return normalized;
}

async function validateCanonicalRoot(root) {
  const lexicalRoot = path.resolve(root);
  const stat = await fsp.lstat(lexicalRoot).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule root must be a directory",
    );
  }
  const canonicalRoot = await fsp.realpath(lexicalRoot);
  if (canonicalRoot !== lexicalRoot) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule root must be canonical",
    );
  }
  return canonicalRoot;
}

async function resolveCommands(root, commandMap) {
  const commands = {};
  for (const [name, relative] of Object.entries(commandMap)) {
    const command = resolveRelativePath(root, relative, `commands.${name}`);
    commands[name] = await validateToolchainCommand(root, command, name);
  }
  return commands;
}

function resolveRelativePath(root, relative, label) {
  const resolved = path.resolve(root, ...relative.split("/"));
  if (!pathIsInside(resolved, root)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      `Eval toolchain capsule ${label} escapes its root`,
    );
  }
  return resolved;
}

async function validateToolchainSymlink(root, symlink) {
  const target = await fsp.readlink(symlink);
  if (path.isAbsolute(target)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule contains an absolute symlink",
    );
  }
  const lexicalTarget = path.resolve(path.dirname(symlink), target);
  if (!pathIsInside(lexicalTarget, root)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule symlink escapes its root",
    );
  }
  const canonicalTarget = await fsp.realpath(symlink).catch(() => null);
  if (!canonicalTarget || !pathIsInside(canonicalTarget, root)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule contains an unsafe symlink",
    );
  }
  return target;
}

async function validateToolchainCommand(root, command, name) {
  const canonical = await fsp.realpath(command).catch(() => null);
  if (!canonical || !pathIsInside(canonical, root)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      `Eval toolchain capsule command ${name} escapes its root`,
    );
  }
  const stat = await fsp.stat(canonical).catch(() => null);
  try {
    await fsp.access(canonical, fsConstants.X_OK);
  } catch {
    throw toolchainError(
      "toolchain_capsule_invalid",
      `Eval toolchain capsule command ${name} is unavailable`,
    );
  }
  if (!stat?.isFile() || stat.nlink !== 1) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      `Eval toolchain capsule command ${name} is unavailable`,
    );
  }
  return canonical;
}

function evalToolchainCapsuleDigest(manifest, treeDigest) {
  digestHexFromValue(treeDigest, "tree digest");
  const commands = Object.fromEntries(
    Object.entries(manifest.commands).sort(compareCommandEntries),
  );
  const identity = {
    kind: manifest.kind,
    toolchain_id: manifest.toolchain_id,
    platform: manifest.platform,
    arch: manifest.arch,
    root: manifest.root,
    commands,
    tree_digest: treeDigest,
  };
  return `sha256:${crypto.createHash("sha256").update(
    "agent-hub-eval-toolchain-capsule-v1\0",
  ).update(JSON.stringify(identity)).digest("hex")}`;
}

async function assertToolchainCapsuleSealed(toolchain) {
  for (const target of [path.dirname(toolchain.manifest_path), toolchain.manifest_path]) {
    const stat = await fsp.lstat(target);
    if ((stat.isFile() && stat.nlink !== 1) || (stat.mode & 0o222)) {
      throw toolchainError(
        "toolchain_capsule_invalid",
        "Eval toolchain capsule is not sealed",
      );
    }
  }
  async function visit(directory) {
    const directoryStat = await fsp.lstat(directory);
    if (directoryStat.mode & 0o222) {
      throw toolchainError(
        "toolchain_capsule_invalid",
        "Eval toolchain capsule is not sealed",
      );
    }
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(target);
      } else if (stat.isFile() && (stat.nlink !== 1 || (stat.mode & 0o222))) {
        throw toolchainError(
          "toolchain_capsule_invalid",
          "Eval toolchain capsule is not sealed",
        );
      }
    }
  }
  await visit(toolchain.root);
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

function compareCommandEntries([left], [right]) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function digestHexFromValue(value, label) {
  const match = typeof value === "string" ? value.match(SHA256_PATTERN) : null;
  if (!match) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      `Eval toolchain capsule ${label} must be a SHA-256 digest`,
    );
  }
  return match[1];
}

async function normalizeForbiddenRoots(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw toolchainError(
      "toolchain_capsule_invalid",
      "Eval toolchain capsule forbidden roots must be an array",
    );
  }
  const roots = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !path.isAbsolute(item)) {
      throw toolchainError(
        "toolchain_capsule_invalid",
        `Eval toolchain capsule forbidden root ${index} must be absolute`,
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
  const canonical = await fsp.realpath(lexical).catch(() => lexical);
  return [lexical, canonical].some((item) =>
    forbiddenRoots.some((root) => pathIsInside(item, root) || pathIsInside(root, item)),
  );
}

async function includesUnsafeRoot(candidates, env) {
  const homes = new Set();
  for (const configuredHome of [env?.HOME, os.homedir()]) {
    if (typeof configuredHome !== "string" || !configuredHome) continue;
    const lexicalHome = path.resolve(configuredHome);
    homes.add(lexicalHome);
    homes.add(await fsp.realpath(lexicalHome).catch(() => lexicalHome));
  }
  return candidates.some((candidate) => {
    const resolved = path.resolve(candidate);
    return resolved === path.parse(resolved).root || homes.has(resolved) ||
      Array.from(homes).some((home) => pathIsInside(home, resolved));
  });
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

async function atomicWriteFile(target, value, mode) {
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

function toolchainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

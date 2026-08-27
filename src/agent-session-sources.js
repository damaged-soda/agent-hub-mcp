import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createSessionIdentity } from "./agent-session-core.js";
import { createTranscriptProjector } from "./agent-session-transcripts.js";
import { projectSessionEvents } from "./agent-session-core.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIMI_ID_PATTERN = /^(?:session|ses)_[0-9a-f-]{36}$/i;
const MAX_LIST_LIMIT = 500;
const MAX_EVENT_LIMIT = 1000;
const MAX_TITLE_LENGTH = 256;
const CLAUDE_TITLE_TAIL_BYTES = 256 * 1024;

export function nativeSessionRoots(env = process.env) {
  const home = os.homedir();
  return {
    codex: path.resolve(env.CODEX_HOME || path.join(home, ".codex")),
    claude: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
    kimi: path.resolve(env.KIMI_CODE_HOME || path.join(home, ".kimi-code")),
  };
}

export async function discoverNativeSessions(options = {}) {
  const provider = optionalProvider(options.provider);
  const limit = boundedInteger(options.limit ?? 50, 1, MAX_LIST_LIMIT, "limit");
  const roots = options.roots ?? nativeSessionRoots(options.env);
  const providers = provider ? [provider] : ["claude", "codex", "kimi"];
  const descriptors = [];
  for (const item of providers) {
    if (item === "claude") descriptors.push(...(await discoverClaude(roots.claude)));
    if (item === "codex") descriptors.push(...(await discoverCodex(roots.codex)));
    if (item === "kimi") descriptors.push(...(await discoverKimi(roots.kimi)));
  }
  descriptors.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  const selected = descriptors.slice(0, limit);
  return Promise.all(selected.map(enrichDescriptor));
}

export async function inspectNativeSession(input, options = {}) {
  const identity = createSessionIdentity(input?.provider, input?.native_session_id);
  if (!identity.native_session_id) throw new Error("native_session_id is required");
  const profile = input.profile ?? "metadata";
  const after = boundedInteger(input.after ?? 0, 0, Number.MAX_SAFE_INTEGER, "after");
  const limit = boundedInteger(input.limit ?? 200, 1, MAX_EVENT_LIMIT, "limit");
  const roots = options.roots ?? nativeSessionRoots(options.env);
  const descriptor = await findSession(identity.provider, identity.native_session_id, roots);
  if (!descriptor) {
    throw new Error(`Unknown ${identity.provider} native_session_id: ${identity.native_session_id}`);
  }
  const projector = createTranscriptProjector(identity.provider, identity.native_session_id);
  const projected = [];
  let sequence = 0;
  let malformedLines = 0;
  const stream = fs.createReadStream(descriptor.source_path, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      for (const event of projector.project(record)) {
        const sequenced = { ...event, sequence };
        sequence += 1;
        if (sequenced.sequence < after) continue;
        projected.push(sequenced);
        if (projected.length > limit) break;
      }
      if (projected.length > limit) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  const hasMore = projected.length > limit;
  const events = projectSessionEvents(projected.slice(0, limit), profile);
  return {
    api_version: 1,
    kind: "agent-session-inspect",
    profile,
    session: await enrichDescriptor(descriptor),
    after,
    next_sequence: events.length > 0 ? events.at(-1).sequence + 1 : after,
    has_more: hasMore,
    malformed_lines: malformedLines,
    data: events,
  };
}

async function discoverCodex(root) {
  const titles = await codexTitleIndex(root);
  const files = [
    ...(await collectFiles(path.join(root, "sessions"), isJsonl)),
    ...(await collectFiles(path.join(root, "archived_sessions"), isJsonl)),
  ];
  const descriptors = [];
  for (const sourcePath of files) {
    const match = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(sourcePath);
    if (!match || !UUID_PATTERN.test(match[1])) continue;
    const descriptor = await baseDescriptor(
      "codex",
      match[1],
      sourcePath,
      sourcePath.includes(`${path.sep}archived_sessions${path.sep}`)
        ? "codex-rollout-archived"
        : "codex-rollout",
    );
    descriptor.title = titles.get(match[1]) ?? null;
    descriptors.push(descriptor);
  }
  return dedupeDescriptors(descriptors);
}

async function discoverClaude(root) {
  const projectsRoot = path.join(root, "projects");
  const projectDirs = await directoryEntries(projectsRoot);
  const descriptors = [];
  for (const projectDir of projectDirs.filter((entry) => entry.isDirectory())) {
    const dir = path.join(projectsRoot, projectDir.name);
    for (const entry of await directoryEntries(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -6);
      if (!UUID_PATTERN.test(sessionId)) continue;
      descriptors.push(
        await baseDescriptor("claude", sessionId, path.join(dir, entry.name), "claude-transcript"),
      );
    }
  }
  return descriptors;
}

async function discoverKimi(root) {
  const indexPath = path.join(root, "session_index.jsonl");
  const text = await fsp.readFile(indexPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const descriptors = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const sessionId = record.sessionId;
    if (typeof sessionId !== "string" || !KIMI_ID_PATTERN.test(sessionId)) continue;
    const sessionDir = safeChildPath(root, record.sessionDir);
    if (!sessionDir) continue;
    const wirePath = path.join(sessionDir, "agents", "main", "wire.jsonl");
    const sourcePath = (await fileExists(wirePath)) ? wirePath : path.join(sessionDir, "state.json");
    if (!(await fileExists(sourcePath))) continue;
    const descriptor = await baseDescriptor("kimi", sessionId, sourcePath, "kimi-wire");
    descriptor.cwd = typeof record.workDir === "string" ? record.workDir : null;
    descriptor.state_path = path.join(sessionDir, "state.json");
    descriptors.push(descriptor);
  }
  return dedupeDescriptors(descriptors);
}

async function findSession(provider, nativeSessionId, roots) {
  const descriptors =
    provider === "codex"
      ? await discoverCodex(roots.codex)
      : provider === "claude"
        ? await discoverClaude(roots.claude)
        : await discoverKimi(roots.kimi);
  return descriptors.find((item) => item.native_session_id === nativeSessionId) ?? null;
}

async function baseDescriptor(provider, nativeSessionId, sourcePath, sourceKind) {
  const stat = await fsp.stat(sourcePath);
  return {
    schema_version: 1,
    provider,
    native_session_id: nativeSessionId,
    source_kind: sourceKind,
    source_path: sourcePath,
    size_bytes: stat.size,
    created_at: stat.birthtime.toISOString(),
    updated_at: stat.mtime.toISOString(),
    cwd: null,
    title: null,
  };
}

async function enrichDescriptor(descriptor) {
  if (descriptor.provider === "kimi" && descriptor.state_path) {
    const state = await readJson(descriptor.state_path);
    return {
      ...descriptor,
      cwd: descriptor.cwd ?? (typeof state?.cwd === "string" ? state.cwd : null),
      title: nativeTitle(state?.title),
    };
  }
  const metadata = await firstMetadataRecord(descriptor);
  const title =
    descriptor.provider === "claude"
      ? await latestClaudeTitle(descriptor)
      : descriptor.title;
  return { ...descriptor, ...metadata, title };
}

async function codexTitleIndex(root) {
  const indexPath = path.join(root, "session_index.jsonl");
  const text = await fsp.readFile(indexPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const titles = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!UUID_PATTERN.test(record.id)) continue;
    const title = nativeTitle(record.thread_name);
    if (title) titles.set(record.id, title);
  }
  return titles;
}

async function latestClaudeTitle(descriptor) {
  const retained = Math.min(descriptor.size_bytes, CLAUDE_TITLE_TAIL_BYTES);
  if (retained <= 0) return null;
  const handle = await fsp.open(descriptor.source_path, "r");
  try {
    const buffer = Buffer.alloc(retained);
    const offset = descriptor.size_bytes - retained;
    const { bytesRead } = await handle.read(buffer, 0, retained, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
    let title = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"ai-title"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== "ai-title" || record.sessionId !== descriptor.native_session_id) continue;
      title = nativeTitle(record.aiTitle) ?? title;
    }
    return title;
  } finally {
    await handle.close();
  }
}

async function firstMetadataRecord(descriptor) {
  const stream = fs.createReadStream(descriptor.source_path, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      count += 1;
      if (count > 128) break;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (descriptor.provider === "codex" && record.type === "session_meta") {
        return {
          cwd: typeof record.payload?.cwd === "string" ? record.payload.cwd : null,
          created_at: timestampValue(record.timestamp ?? record.payload?.timestamp) ?? descriptor.created_at,
        };
      }
      if (descriptor.provider === "claude" && record.sessionId === descriptor.native_session_id) {
        const cwd = typeof record.cwd === "string" ? record.cwd : null;
        const createdAt = timestampValue(record.timestamp);
        if (cwd || createdAt) {
          return { cwd, created_at: createdAt ?? descriptor.created_at };
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return {};
}

async function collectFiles(root, predicate) {
  const entries = await directoryEntries(root);
  const files = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(target, predicate)));
    else if (entry.isFile() && predicate(target)) files.push(target);
  }
  return files;
}

async function directoryEntries(root) {
  return fsp.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
}

function dedupeDescriptors(descriptors) {
  const selected = new Map();
  for (const descriptor of descriptors) {
    const current = selected.get(descriptor.native_session_id);
    const preferActive =
      current?.source_kind === "codex-rollout-archived" && descriptor.source_kind === "codex-rollout";
    if (!current || preferActive || descriptor.updated_at > current.updated_at) {
      selected.set(descriptor.native_session_id, descriptor);
    }
  }
  return Array.from(selected.values());
}

function safeChildPath(root, candidate) {
  if (typeof candidate !== "string" || !candidate) return null;
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? resolved : null;
}

function optionalProvider(value) {
  if (value === undefined || value === null || value === "") return null;
  return createSessionIdentity(value, null).provider;
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function timestampValue(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (!Number.isFinite(value)) return null;
  const millis = value > 100000000000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function nativeTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return Array.from(title).slice(0, MAX_TITLE_LENGTH).join("");
}

function isJsonl(value) {
  return value.endsWith(".jsonl");
}

async function fileExists(value) {
  try {
    return (await fsp.stat(value)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(value) {
  try {
    return JSON.parse(await fsp.readFile(value, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

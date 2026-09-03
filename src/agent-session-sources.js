import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { runCommand } from "./adapter-utils.js";
import {
  createContextObservation,
  createSessionIdentity,
  projectSessionEvents,
} from "./agent-session-core.js";
import {
  AGENT_SESSION_EVENT_ID_VERSION,
  AGENT_SESSION_REFERENCE_VERSION,
  createNativeEventReferenceProjector,
  formatAgentSessionReference,
  parseAgentSessionReference,
  parseAgentSessionEventReference,
} from "./agent-session-references.js";
import { createTranscriptProjector, openCodeExportRecords } from "./agent-session-transcripts.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIMI_ID_PATTERN = /^(?:session|ses)_[0-9a-f-]{36}$/i;
const OPENCODE_ID_PATTERN = /^ses_[0-9A-Za-z]{8,128}$/;
const MAX_LIST_LIMIT = 500;
const MAX_EVENT_LIMIT = 1000;
const MAX_QUERY_LENGTH = 200;
const MAX_OPENCODE_DISCOVERY_LIMIT = 5000;
const ENRICH_CONCURRENCY = 32;
const QUERY_FIELDS = ["title", "cwd", "native_session_id", "provider", "source_kind"];
const MAX_TITLE_LENGTH = 256;
const CLAUDE_TITLE_TAIL_BYTES = 64 * 1024;
const OPENCODE_SQLITE_TIMEOUT_MS = 15000;
const OPENCODE_QUERY_MAX_BYTES = 64 * 1024 * 1024;
const OPENCODE_SESSION_QUERY = (limit) => [
  "select id, title, directory, time_created, time_updated",
  "from session",
  "where parent_id is null",
  "order by time_updated desc",
  `limit ${limit}`,
].join(" ");

export function nativeSessionRoots(env = process.env) {
  const home = os.homedir();
  return {
    codex: path.resolve(env.CODEX_HOME || path.join(home, ".codex")),
    claude: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
    kimi: path.resolve(env.KIMI_CODE_HOME || path.join(home, ".kimi-code")),
    opencode: path.resolve(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode"),
  };
}

export async function discoverNativeSessions(options = {}) {
  const provider = optionalProvider(options.provider);
  const limit = boundedInteger(options.limit ?? 50, 1, MAX_LIST_LIMIT, "limit");
  const query = optionalSearchQuery(options.query);
  const roots = options.roots ?? nativeSessionRoots(options.env);
  const providers = provider ? [provider] : ["claude", "codex", "kimi", "opencode"];
  const descriptors = [];
  const sourceErrors = [];
  for (const item of providers) {
    try {
      if (item === "claude") descriptors.push(...(await discoverClaude(roots.claude)));
      if (item === "codex") descriptors.push(...(await discoverCodex(roots.codex)));
      if (item === "kimi") descriptors.push(...(await discoverKimi(roots.kimi)));
      if (item === "opencode") descriptors.push(...(await discoverOpenCode(roots.opencode, options)));
    } catch (error) {
      if (provider) throw error;
      sourceErrors.push({
        provider: item,
        code: "source_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  descriptors.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  const totalDiscovered = descriptors.length;
  // 一次搜索要富集整个目录，任何一个陈旧或不可读的原生文件都不能拖垮其余会话。
  // 读不到的证据按未知呈现，并按 provider 汇总进 source_errors，不静默吞掉。
  const enrichFailures = new Map();
  const enrichOne = async (descriptor) => {
    try {
      return await enrichDescriptor(descriptor);
    } catch (error) {
      const failure = enrichFailures.get(descriptor.provider);
      if (failure) failure.count += 1;
      else {
        enrichFailures.set(descriptor.provider, {
          count: 1,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return descriptor;
    }
  };
  let matched = totalDiscovered;
  let data;
  if (query) {
    const enriched = await mapBounded(descriptors, ENRICH_CONCURRENCY, enrichOne);
    const hits = enriched.filter((item) => matchesQuery(item, query));
    matched = hits.length;
    data = hits.slice(0, limit);
  } else {
    data = await mapBounded(descriptors.slice(0, limit), ENRICH_CONCURRENCY, enrichOne);
  }
  for (const [item, failure] of enrichFailures) {
    sourceErrors.push({
      provider: item,
      code: "session_metadata_unreadable",
      message: `${failure.count} session(s) kept unknown cwd and title: ${failure.message}`,
    });
  }
  Object.defineProperty(data, "source_errors", { value: sourceErrors });
  Object.defineProperty(data, "total_discovered", { value: totalDiscovered });
  Object.defineProperty(data, "matched", { value: matched });
  Object.defineProperty(data, "query", { value: query });
  return data;
}

export async function inspectNativeSession(input, options = {}) {
  const identity = createSessionIdentity(input?.provider, input?.native_session_id);
  if (!identity.native_session_id) throw new Error("native_session_id is required");
  const profile = input.profile ?? "metadata";
  const after = boundedInteger(input.after ?? 0, 0, Number.MAX_SAFE_INTEGER, "after");
  const limit = boundedInteger(input.limit ?? 200, 1, MAX_EVENT_LIMIT, "limit");
  const roots = options.roots ?? nativeSessionRoots(options.env);
  const descriptor = await findSession(identity.provider, identity.native_session_id, roots, options);
  if (!descriptor) {
    throw new Error(`Unknown ${identity.provider} native_session_id: ${identity.native_session_id}`);
  }
  const projected = [];
  const scan = await walkNativeSessionEvents(descriptor, identity, (event) => {
    if (event.sequence < after) return true;
    projected.push(event);
    return projected.length <= limit;
  }, options);
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
    malformed_lines: scan.malformed_lines,
    data: events,
  };
}

export async function resolveNativeSessionEventReference(value, options = {}) {
  const parsed = parseAgentSessionEventReference(value);
  const roots = options.roots ?? nativeSessionRoots(options.env);
  const descriptor = await findSession(parsed.provider, parsed.native_session_id, roots, options);
  if (!descriptor) {
    throw new Error(`Unknown ${parsed.provider} native_session_id: ${parsed.native_session_id}`);
  }

  let target = null;
  let related = null;
  let precedingToolCallSequence = null;
  const toolCallSequences = new Map();
  const effectiveContext = {};
  const scan = await walkNativeSessionEvents(descriptor, parsed, (event) => {
    if (!target) {
      if (event.kind === "context") Object.assign(effectiveContext, event.data ?? {});
      const toolCallId = event.data?.tool_call_id;
      if (event.kind === "tool-call" && typeof toolCallId === "string") {
        toolCallSequences.set(toolCallId, event.sequence);
      }
      if (event.event_ref !== parsed.reference) return true;
      target = event;
      if (event.kind === "tool-result" && typeof toolCallId === "string") {
        precedingToolCallSequence = toolCallSequences.get(toolCallId) ?? null;
        return false;
      }
      return event.kind === "tool-call" && typeof toolCallId === "string";
    }

    const targetToolCallId = target.data?.tool_call_id;
    if (
      target.kind === "tool-call" &&
      event.kind === "tool-result" &&
      typeof targetToolCallId === "string" &&
      event.data?.tool_call_id === targetToolCallId
    ) {
      related = event;
      return false;
    }
    return true;
  }, options);

  if (!target) {
    throw new Error(`Stale Agent Session event reference: ${parsed.reference}`);
  }
  if (!related && Number.isInteger(precedingToolCallSequence)) {
    related = await readEventAtSequence(descriptor, parsed, precedingToolCallSequence, options);
  }
  const boundedTarget = projectSessionEvents([target], "inspect")[0];
  const boundedRelated = related ? projectSessionEvents([related], "inspect") : [];
  const boundedContext = Object.keys(effectiveContext).length > 0
    ? projectSessionEvents([
        createContextObservation({
          provider: parsed.provider,
          native_session_id: parsed.native_session_id,
          sequence: target.sequence,
          context: effectiveContext,
          occurred_at: target.occurred_at,
          stage: "inferred",
          source: "native-transcript",
          native_type: "agenthub/effective-context",
        }),
      ], "inspect")[0]
    : null;
  return {
    api_version: 1,
    kind: "agent-session-event-resolution",
    reference: parsed.reference,
    reference_protocol: {
      version: AGENT_SESSION_REFERENCE_VERSION,
      event_id_version: AGENT_SESSION_EVENT_ID_VERSION,
    },
    session: await enrichDescriptor(descriptor),
    malformed_lines: scan.malformed_lines,
    data: {
      target: boundedTarget,
      related: boundedRelated,
      effective_context: boundedContext,
    },
  };
}

export async function resolveNativeSessionReference(value, options = {}) {
  const parsed = parseAgentSessionReference(value);
  if (parsed.reference_kind === "event") {
    return resolveNativeSessionEventReference(value, options);
  }
  const roots = options.roots ?? nativeSessionRoots(options.env);
  const descriptor = await findSession(parsed.provider, parsed.native_session_id, roots, options);
  if (!descriptor) {
    throw new Error(`Unknown ${parsed.provider} native_session_id: ${parsed.native_session_id}`);
  }
  return {
    api_version: 1,
    kind: "agent-session-resolution",
    reference: parsed.reference,
    reference_protocol: { version: AGENT_SESSION_REFERENCE_VERSION },
    session: await enrichDescriptor(descriptor),
  };
}

async function walkNativeSessionEvents(descriptor, identity, visitor, options = {}) {
  const projector = createTranscriptProjector(identity.provider, identity.native_session_id);
  const referenceProjector = createNativeEventReferenceProjector(
    identity.provider,
    identity.native_session_id,
  );
  let sequence = 0;
  let malformedLines = 0;
  if (descriptor.provider === "opencode") {
    const document = await readOpenCodeExport(
      descriptor.source_path,
      descriptor.native_session_id,
      options,
    );
    const records = openCodeExportRecords(document);
    malformedLines = records.malformed_records ?? 0;
    for (const record of records) {
      const events = referenceProjector.attach(record, projector.project(record));
      for (const event of events) {
        const sequenced = { ...event, sequence };
        sequence += 1;
        if (visitor(sequenced) === false) {
          return { malformed_lines: malformedLines, next_sequence: sequence, stopped: true };
        }
      }
    }
    return { malformed_lines: malformedLines, next_sequence: sequence, stopped: false };
  }
  // 一个会话可能被原生 CLI 写成多段 rollout 文件；投影器与 sequence 必须跨段延续，
  // 否则续写的部分要么读不到，要么拿到和单段读取不一致的 event_ref。
  for (const segment of sessionSegments(descriptor)) {
    const stream = fs.createReadStream(segment.source_path, { encoding: "utf8" });
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
        const events = referenceProjector.attach(record, projector.project(record));
        for (const event of events) {
          const sequenced = { ...event, sequence };
          sequence += 1;
          if (visitor(sequenced) === false) {
            return { malformed_lines: malformedLines, next_sequence: sequence, stopped: true };
          }
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return { malformed_lines: malformedLines, next_sequence: sequence, stopped: false };
}

// 段列表是唯一的读取顺序来源；非分段 provider 退化为单段，读取路径无需分叉。
function sessionSegments(descriptor) {
  return Array.isArray(descriptor.segments) && descriptor.segments.length > 0
    ? descriptor.segments
    : [descriptor];
}

async function readEventAtSequence(descriptor, identity, targetSequence, options = {}) {
  let selected = null;
  await walkNativeSessionEvents(descriptor, identity, (event) => {
    if (event.sequence < targetSequence) return true;
    if (event.sequence === targetSequence) selected = event;
    return false;
  }, options);
  return selected;
}

async function discoverCodex(root, options = {}) {
  const titles = await codexTitleIndex(root);
  const files = [
    ...(await collectFiles(path.join(root, "sessions"), isJsonl)),
    ...(await collectFiles(path.join(root, "archived_sessions"), isJsonl)),
  ];
  const descriptors = [];
  for (const sourcePath of files) {
    const parsed = parseCodexRolloutName(sourcePath);
    if (!parsed) continue;
    const descriptor = await baseDescriptor(
      "codex",
      parsed.native_session_id,
      sourcePath,
      sourcePath.includes(`${path.sep}archived_sessions${path.sep}`)
        ? "codex-rollout-archived"
        : "codex-rollout",
    );
    descriptor.title = titles.get(parsed.native_session_id) ?? null;
    descriptor.rollout_id = parsed.rollout_id;
    descriptor.rollout_started_at = parsed.rollout_started_at;
    descriptors.push(descriptor);
  }
  return options.dedupe === false ? descriptors : chainCodexSegments(descriptors);
}

// Codex 在 resume/compact 后会另起一个 rollout 文件，文件名成为
// `rollout-<时间戳>-<会话 id>_<rollout id>.jsonl`。第一段 UUID 才是会话身份
// （与文件内 session_meta.session_id 一致），第二段只是这一段 rollout 自己的 id。
// 旧解析从文件名尾部取 UUID，于是把续写段认成一个原生证据里根本不存在的会话，
// 原会话则停在中断处。
function parseCodexRolloutName(sourcePath) {
  const name = path.basename(sourcePath);
  if (!name.endsWith(".jsonl")) return null;
  const stem = name.slice(0, -".jsonl".length);
  const separator = stem.lastIndexOf("_");
  if (separator !== -1) {
    const rolloutId = stem.slice(separator + 1);
    const sessionId = stem.slice(0, separator).slice(-36);
    if (UUID_PATTERN.test(rolloutId) && UUID_PATTERN.test(sessionId)) {
      return {
        native_session_id: sessionId,
        rollout_id: rolloutId,
        rollout_started_at: rolloutStartLabel(stem),
      };
    }
  }
  const sessionId = stem.slice(-36);
  if (!UUID_PATTERN.test(sessionId)) return null;
  return {
    native_session_id: sessionId,
    rollout_id: null,
    rollout_started_at: rolloutStartLabel(stem),
  };
}

function rolloutStartLabel(stem) {
  const match = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(stem);
  return match ? match[1] : null;
}

// 同一 rollout id 的多个文件是同一份证据的副本（活跃目录与归档目录），沿用既有的
// 副本规则；不同 rollout id 是同一会话的不同段，必须按序串成一条链而不是互相顶掉。
function chainCodexSegments(descriptors) {
  const sessions = [];
  for (const [, group] of groupBy(descriptors, (item) => item.native_session_id)) {
    const segments = [];
    for (const [, copies] of groupBy(group, (item) => item.rollout_id ?? "")) {
      segments.push(pickRolloutCopy(copies));
    }
    sessions.push(chainedCodexSession(segments.sort(compareCodexSegments), group.length));
  }
  return sessions;
}

function pickRolloutCopy(copies) {
  return copies.length === 1 ? copies[0] : [...copies].sort(compareDuplicateSources)[0];
}

function chainedCodexSession(segments, sourceFileCount) {
  // rollout id 与 rollout 起始时间是段的属性，不是会话的属性，只留在 segments[] 里。
  const [{ rollout_id: _rolloutId, rollout_started_at: _startedAt, ...first }] = segments;
  const session = {
    ...first,
    size_bytes: segments.reduce((total, item) => total + item.size_bytes, 0),
    updated_at: segments.reduce(
      (latest, item) => (item.updated_at > latest ? item.updated_at : latest),
      first.updated_at,
    ),
    segments: segments.map((item) => ({
      source_kind: item.source_kind,
      source_path: item.source_path,
      rollout_id: item.rollout_id,
      size_bytes: item.size_bytes,
      created_at: item.created_at,
      updated_at: item.updated_at,
    })),
  };
  // duplicate_source_count 只报告“同一段存在额外副本”，段本身不是副本。
  if (sourceFileCount > segments.length) session.duplicate_source_count = sourceFileCount;
  return session;
}

// 根段（无 rollout id）永远在最前，其余按文件名时间戳排序，最后用路径兜底稳定性。
// 不用 ordinal：resume 会回退 ordinal，compact 会把它重置为 0。
function compareCodexSegments(left, right) {
  const leftRank = left.rollout_id === null ? 0 : 1;
  const rightRank = right.rollout_id === null ? 0 : 1;
  return (
    leftRank - rightRank ||
    String(left.rollout_started_at ?? "").localeCompare(String(right.rollout_started_at ?? "")) ||
    left.source_path.localeCompare(right.source_path)
  );
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

async function discoverClaude(root, options = {}) {
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
  return options.dedupe === false ? descriptors : dedupeDescriptors(descriptors);
}

async function discoverKimi(root, options = {}) {
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
  return options.dedupe === false ? descriptors : dedupeDescriptors(descriptors);
}

async function discoverOpenCode(root, options = {}) {
  if (!root) return [];
  const sourcePath = path.join(root, "opencode.db");
  if (!(await fileExists(sourcePath))) return [];
  const rows = await runSqliteJson(
    sourcePath,
    OPENCODE_SESSION_QUERY(MAX_OPENCODE_DISCOVERY_LIMIT),
    options,
  );
  if (!Array.isArray(rows)) throw new Error("OpenCode session query did not return an array");
  const descriptors = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (typeof row.id !== "string" || !OPENCODE_ID_PATTERN.test(row.id)) continue;
    const createdAt = timestampValue(row.time_created);
    const updatedAt = timestampValue(row.time_updated);
    if (!createdAt || !updatedAt) continue;
    descriptors.push({
      schema_version: 1,
      provider: "opencode",
      native_session_id: row.id,
      session_ref: formatAgentSessionReference({ provider: "opencode", native_session_id: row.id }),
      source_kind: "opencode-export",
      source_path: sourcePath,
      size_bytes: null,
      created_at: createdAt,
      updated_at: updatedAt,
      cwd: typeof row.directory === "string" && row.directory ? row.directory : null,
      title: nativeTitle(row.title),
    });
  }
  return dedupeDescriptors(descriptors);
}

async function readOpenCodeExport(sourcePath, nativeSessionId, options = {}) {
  if (!OPENCODE_ID_PATTERN.test(nativeSessionId)) {
    throw new Error("Invalid OpenCode native_session_id");
  }
  const id = nativeSessionId;
  const sessionRows = await runSqliteJson(
    sourcePath,
    [
      "select id, project_id, slug, directory, path, title, version,",
      "summary_additions, summary_deletions, summary_files, summary_diffs,",
      "cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,",
      "tokens_cache_write, permission, agent, model, time_created, time_updated",
      `from session where id = '${id}' limit 1`,
    ].join(" "),
    options,
  );
  if (!Array.isArray(sessionRows) || sessionRows.length !== 1) {
    throw new Error("OpenCode session row did not match the requested session");
  }
  const messageRows = await runSqliteJson(
    sourcePath,
    `select id, session_id, time_created, time_updated, data from message where session_id = '${id}' order by time_created, id`,
    options,
    OPENCODE_QUERY_MAX_BYTES,
  );
  const partRows = await runSqliteJson(
    sourcePath,
    `select id, message_id, session_id, time_created, time_updated, data from part where session_id = '${id}' order by time_created, id`,
    options,
    OPENCODE_QUERY_MAX_BYTES,
  );
  return openCodeDocumentFromRows(sessionRows[0], messageRows, partRows);
}

async function runSqliteJson(
  sourcePath,
  query,
  options = {},
  maxOutputBytes = 8 * 1024 * 1024,
) {
  const execute = options.sqliteCommand ?? ((commandArgs, commandOptions) =>
    runCommand("sqlite3", commandArgs, commandOptions));
  const result = await execute(["-readonly", "-json", sourcePath, query], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    maxOutputBytes,
    timeoutMs: OPENCODE_SQLITE_TIMEOUT_MS,
  });
  if (result?.error || result?.code !== 0) {
    const detail = result?.error?.message || result?.stderr?.trim() || `exit ${result?.code}`;
    throw new Error(`OpenCode SQLite read failed: ${detail}`);
  }
  try {
    return JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new Error("OpenCode SQLite read returned invalid JSON");
  }
}

function openCodeDocumentFromRows(sessionRow, messageRows, partRows) {
  if (!Array.isArray(messageRows) || !Array.isArray(partRows)) {
    throw new Error("OpenCode SQLite transcript query did not return arrays");
  }
  const malformed = { count: 0 };
  const messages = new Map();
  for (const row of messageRows) {
    const data = parseOpenCodeJsonColumn(row?.data, malformed);
    if (!data) continue;
    if (row.session_id !== sessionRow.id || typeof row.id !== "string") {
      malformed.count += 1;
      continue;
    }
    const info = {
      ...data,
      id: row.id,
      sessionID: row.session_id,
      time: data.time ?? { created: row.time_created, updated: row.time_updated },
    };
    messages.set(row.id, { info, parts: [] });
  }
  for (const row of partRows) {
    const data = parseOpenCodeJsonColumn(row?.data, malformed);
    const message = messages.get(row?.message_id);
    if (!data) continue;
    if (!message || row.session_id !== sessionRow.id || typeof row.id !== "string") {
      malformed.count += 1;
      continue;
    }
    message.parts.push({
      ...data,
      id: row.id,
      messageID: row.message_id,
      sessionID: row.session_id,
    });
  }
  const model = parseOpenCodeJsonColumn(sessionRow.model, malformed);
  const permission = parseOpenCodeJsonColumn(sessionRow.permission, malformed);
  const summaryDiffs = parseOpenCodeJsonColumn(sessionRow.summary_diffs, malformed);
  const document = {
    info: {
      id: sessionRow.id,
      slug: sessionRow.slug,
      projectID: sessionRow.project_id,
      directory: sessionRow.directory,
      path: sessionRow.path ?? "",
      title: sessionRow.title,
      agent: sessionRow.agent,
      model,
      version: sessionRow.version,
      summary: {
        additions: sessionRow.summary_additions,
        deletions: sessionRow.summary_deletions,
        files: sessionRow.summary_files,
        diffs: summaryDiffs,
      },
      cost: sessionRow.cost,
      tokens: {
        input: sessionRow.tokens_input,
        output: sessionRow.tokens_output,
        reasoning: sessionRow.tokens_reasoning,
        cache: { read: sessionRow.tokens_cache_read, write: sessionRow.tokens_cache_write },
      },
      permission,
      time: { created: sessionRow.time_created, updated: sessionRow.time_updated },
    },
    messages: Array.from(messages.values()),
  };
  Object.defineProperty(document, "malformed_records", { value: malformed.count });
  return document;
}

function parseOpenCodeJsonColumn(value, malformed) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    malformed.count += 1;
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    malformed.count += 1;
    return null;
  }
}

async function findSession(provider, nativeSessionId, roots, options = {}) {
  const descriptors =
    provider === "codex"
      ? await discoverCodex(roots.codex, { dedupe: false })
      : provider === "claude"
        ? await discoverClaude(roots.claude, { dedupe: false })
        : provider === "kimi"
          ? await discoverKimi(roots.kimi, { dedupe: false })
          : await discoverOpenCode(roots.opencode, options);
  const matches = descriptors.filter((item) => item.native_session_id === nativeSessionId);
  if (matches.length === 0) return null;
  if (provider === "codex") {
    const [session] = await chainCodexSegmentsStrict(matches, nativeSessionId);
    return session ?? null;
  }
  if (matches.length === 1) return matches[0];
  const digests = await Promise.all(matches.map((item) => fileSha256(item.source_path)));
  if (new Set(digests).size !== 1) {
    throw new Error(
      `Ambiguous ${provider} native_session_id has conflicting transcript sources: ${nativeSessionId}`,
    );
  }
  const selected = [...matches].sort(compareDuplicateSources)[0];
  return { ...selected, duplicate_source_count: matches.length };
}

// 读取路径要 fail loud：同一 rollout 段的多个副本必须逐字节一致，否则拒绝在同名证据
// 之间挑一个。段与段之间内容本来就不同，不参与这个比对。
async function chainCodexSegmentsStrict(descriptors, nativeSessionId) {
  for (const [, copies] of groupBy(descriptors, (item) => item.rollout_id ?? "")) {
    if (copies.length === 1) continue;
    const digests = await Promise.all(copies.map((item) => fileSha256(item.source_path)));
    if (new Set(digests).size !== 1) {
      throw new Error(
        `Ambiguous codex native_session_id has conflicting transcript sources: ${nativeSessionId}`,
      );
    }
  }
  return chainCodexSegments(descriptors);
}

async function baseDescriptor(provider, nativeSessionId, sourcePath, sourceKind) {
  const stat = await fsp.stat(sourcePath);
  return {
    schema_version: 1,
    provider,
    native_session_id: nativeSessionId,
    session_ref: formatAgentSessionReference({
      provider,
      native_session_id: nativeSessionId,
    }),
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
  if (descriptor.provider === "opencode") return descriptor;
  if (descriptor.provider === "kimi" && descriptor.state_path) {
    const state = await readJson(descriptor.state_path);
    return {
      ...descriptor,
      cwd: descriptor.cwd ?? (typeof state?.cwd === "string" ? state.cwd : null),
      title: state?.isCustomTitle === true ? nativeTitle(state.title) : null,
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
  const handle = await fsp.open(descriptor.source_path, "r").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const buffer = Buffer.allocUnsafe(retained);
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
  let claudeCreatedAt = null;
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
        claudeCreatedAt ??= timestampValue(record.timestamp);
        if (cwd) {
          return { cwd, created_at: claudeCreatedAt ?? descriptor.created_at };
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (descriptor.provider === "claude" && claudeCreatedAt) {
    return { cwd: null, created_at: claudeCreatedAt };
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

// Codex 走 chainCodexSegments，这里只服务一个会话对应一个原生文件的 provider。
function dedupeDescriptors(descriptors) {
  const selected = new Map();
  for (const descriptor of descriptors) {
    const current = selected.get(descriptor.native_session_id);
    if (!current || descriptor.updated_at > current.updated_at) {
      selected.set(descriptor.native_session_id, descriptor);
    }
  }
  return Array.from(selected.values());
}

function compareDuplicateSources(left, right) {
  const leftRank = left.source_kind === "codex-rollout" ? 0 : 1;
  const rightRank = right.source_kind === "codex-rollout" ? 0 : 1;
  return leftRank - rightRank || left.source_path.localeCompare(right.source_path);
}

async function fileSha256(sourcePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(sourcePath)) hash.update(chunk);
  return hash.digest("hex");
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

function optionalSearchQuery(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("query must be a string");
  const normalized = value.trim();
  if (!normalized) return null;
  if (Array.from(normalized).length > MAX_QUERY_LENGTH) {
    throw new Error(`query must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  return normalized.toLowerCase();
}

function matchesQuery(descriptor, query) {
  return QUERY_FIELDS.some((field) => {
    const value = descriptor[field];
    return typeof value === "string" && value.toLowerCase().includes(query);
  });
}

async function mapBounded(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: poolSize }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
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

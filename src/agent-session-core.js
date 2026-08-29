import { extractResourceAccesses } from "./agent-session-resources.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

export const AGENT_SESSION_SCHEMA_VERSION = 1;
export const AGENT_SESSION_PROVIDERS = Object.freeze(["claude", "codex", "kimi", "opencode"]);
export const AGENT_SESSION_CONTENT_PROFILES = Object.freeze(["inspect", "metadata"]);
export const AGENT_SESSION_INSPECT_LIMITS = Object.freeze({
  string_chars: 8192,
  array_items: 100,
  object_keys: 100,
  depth: 8,
});
export const AGENT_SESSION_EVENT_KINDS = Object.freeze([
  "session",
  "context",
  "message",
  "turn-start",
  "turn-end",
  "model-call",
  "tool-call",
  "tool-result",
  "error",
  "rate-limit",
]);

const AGENT_ID_TO_PROVIDER = Object.freeze({
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  kimi: "kimi",
  "kimi-code": "kimi",
  opencode: "opencode",
});

const PROVENANCE_STAGES = new Set(["requested", "launched", "observed", "inferred", "unknown"]);
const PROVENANCE_SOURCES = new Set([
  "live-stream",
  "native-transcript",
  "agenthub-request",
  "agenthub-command",
]);

export function canonicalProvider(value) {
  const provider = AGENT_ID_TO_PROVIDER[value];
  if (!provider) {
    throw new Error(`Unsupported agent session provider: ${value}`);
  }
  return provider;
}

export function createSessionIdentity(providerValue, nativeSessionId) {
  const provider = canonicalProvider(providerValue);
  if (
    nativeSessionId !== null &&
    (typeof nativeSessionId !== "string" || !SESSION_ID_PATTERN.test(nativeSessionId))
  ) {
    throw new Error("native_session_id must be null or a non-empty provider session id");
  }
  return {
    provider,
    native_session_id: nativeSessionId,
  };
}

export function parseJsonLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function createContextObservation(input) {
  if (!input?.context || typeof input.context !== "object" || Array.isArray(input.context)) {
    throw new Error("context must be an object");
  }
  return createSessionEvent({ ...input, kind: "context", data: input.context });
}

export function createSessionEvent(input) {
  const identity = createSessionIdentity(input?.provider, input?.native_session_id ?? null);
  const stage = input?.stage ?? "unknown";
  const source = input?.source ?? "native-transcript";
  if (!PROVENANCE_STAGES.has(stage)) throw new Error(`Unsupported provenance stage: ${stage}`);
  if (!PROVENANCE_SOURCES.has(source)) throw new Error(`Unsupported provenance source: ${source}`);
  if (!AGENT_SESSION_EVENT_KINDS.includes(input?.kind)) {
    throw new Error(`Unsupported agent session event kind: ${input?.kind}`);
  }
  if (!input?.data || typeof input.data !== "object" || Array.isArray(input.data)) {
    throw new Error("data must be an object");
  }
  if (
    input.occurred_at !== undefined &&
    input.occurred_at !== null &&
    (typeof input.occurred_at !== "string" || !input.occurred_at.trim())
  ) {
    throw new Error("occurred_at must be null or a non-empty string");
  }
  if (
    input.native_type !== undefined &&
    (typeof input.native_type !== "string" || !input.native_type.trim())
  ) {
    throw new Error("native_type must be a non-empty string");
  }
  return {
    schema_version: AGENT_SESSION_SCHEMA_VERSION,
    ...identity,
    sequence: Number.isInteger(input.sequence) && input.sequence >= 0 ? input.sequence : 0,
    kind: input.kind,
    occurred_at: input.occurred_at ?? null,
    data: structuredClone(input.data),
    provenance: {
      stage,
      source,
      native_type: input.native_type ?? "context",
    },
  };
}

export function detectLiveProvider(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (typeof record.role === "string") return "kimi";
  if (
    typeof record.type === "string" &&
    (record.type.includes(".") ||
      record.item ||
      (record.type === "error" && typeof record.message === "string"))
  ) {
    return "codex";
  }
  if (
    ["system", "assistant", "user", "result", "rate_limit_event"].includes(record.type)
  ) {
    return "claude";
  }
  return null;
}

export function summarizeLiveRecord(record, maxLength = 1000) {
  const provider = detectLiveProvider(record);
  if (!provider) return null;
  const summaries = projectLiveRecord(provider, record)
    .map((event) => summarizeSessionEvent(event, maxLength))
    .filter(Boolean);
  if (summaries.length === 0) return null;
  const toolSummaries = summaries.filter((summary) => summary.message?.startsWith("Using tools: "));
  if (toolSummaries.length > 1 && toolSummaries.length === summaries.length) {
    const tools = toolSummaries.map((summary) => summary.message.slice(13, -1));
    return { ...toolSummaries[0], message: `Using tools: ${tools.join(", ")}.` };
  }
  return summaries[0];
}

export function projectLiveStream(providerValue, input, options = {}) {
  const provider = canonicalProvider(providerValue);
  const records = Array.isArray(input) ? input : parseJsonLines(input);
  const nativeSessionId =
    options.native_session_id ?? inferNativeSessionId(provider, records) ?? null;
  let sequence = Number.isInteger(options.start_sequence) ? options.start_sequence : 0;
  const projected = [];
  for (const record of records) {
    for (const event of projectLiveRecord(provider, record, { nativeSessionId })) {
      projected.push({ ...event, sequence });
      sequence += 1;
    }
  }
  return projectSessionEvents(projected, options.profile ?? "inspect");
}

export function projectLiveRecord(providerValue, record, options = {}) {
  const provider = canonicalProvider(providerValue);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return [];
  }
  const nativeSessionId =
    options.nativeSessionId ?? inferNativeSessionId(provider, [record]) ?? null;
  const base = {
    schema_version: AGENT_SESSION_SCHEMA_VERSION,
    provider,
    native_session_id: nativeSessionId,
    sequence: Number.isInteger(options.sequence) && options.sequence >= 0 ? options.sequence : 0,
    occurred_at: eventTimestamp(record),
    provenance: {
      stage: "observed",
      source: "live-stream",
      native_type: nativeEventType(provider, record),
    },
  };
  if (provider === "claude") return projectClaudeRecord(record, base);
  if (provider === "codex") return projectCodexRecord(record, base);
  if (provider === "opencode") return [];
  return projectKimiRecord(record, base);
}

export function projectSessionEvents(events, profile = "inspect") {
  if (!Array.isArray(events)) throw new Error("events must be an array");
  if (!AGENT_SESSION_CONTENT_PROFILES.includes(profile)) {
    throw new Error(`Unsupported agent session content profile: ${profile}`);
  }
  if (profile === "inspect") {
    return events.map(boundInspectEvent);
  }
  return events.map(projectMetadataEvent);
}

export function sessionRefFromLiveEvent(providerValue, record) {
  const provider = canonicalProvider(providerValue);
  const nativeSessionId = inferNativeSessionId(provider, [record]);
  if (!nativeSessionId) return null;
  return {
    agent_id:
      provider === "claude"
        ? "claude-code"
        : provider === "kimi"
          ? "kimi-code"
          : provider === "opencode"
            ? "opencode"
            : "codex",
    native_session_id: nativeSessionId,
  };
}

export function summarizeSessionEvent(event, maxLength = 1000) {
  const sessionId = event?.native_session_id ?? undefined;
  if (event?.kind === "session") {
    return {
      type: "system",
      message: `${providerLabel(event.provider)} session started.`,
      session_id: sessionId,
    };
  }
  if (event?.kind === "context") {
    return {
      type: "system",
      message: `${providerLabel(event.provider)} session initialized${
        event.data?.model ? ` with ${event.data.model}` : ""
      }.`,
      session_id: sessionId,
    };
  }
  if (event?.kind === "message" && event.data?.role === "assistant" && event.data.content) {
    return {
      type: "assistant",
      message: truncate(event.data.content.trim(), maxLength),
      session_id: sessionId,
    };
  }
  if (event?.kind === "tool-call") {
    const toolName = event.data?.tool_name || "tool";
    if (event.provider === "codex" && event.data?.tool_kind === "shell") {
      const command = event.data?.arguments?.command;
      return {
        type: "assistant",
        message:
          typeof command === "string" && command.trim()
            ? `Running command: ${truncate(command.trim(), 200)}`
            : "Running a command.",
        session_id: sessionId,
      };
    }
    if (event.provider === "codex" && event.data?.tool_kind === "edit") {
      const paths = event.data?.target_paths ?? [];
      return {
        type: "assistant",
        message:
          paths.length > 0
            ? `Edited files: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""}`
            : "Editing files.",
        session_id: sessionId,
      };
    }
    return {
      type: "assistant",
      message: `Using tools: ${toolName}.`,
      session_id: sessionId,
    };
  }
  if (event?.kind === "turn-end") {
    const failed = event.data?.status === "failed";
    const result = typeof event.data?.result === "string" ? event.data.result.trim() : "";
    const detail = result ? ` ${truncate(result, maxLength)}` : "";
    return {
      type: "result",
      message: `${failed ? "Failed" : "Completed"}${detail}`,
      session_id: sessionId,
    };
  }
  if (event?.kind === "error") {
    return {
      type: "error",
      message: truncate(event.data?.message || "Agent error.", maxLength),
      session_id: sessionId,
    };
  }
  if (event?.kind === "rate-limit") {
    return {
      type: "rate_limit",
      message: event.data?.status
        ? `Rate limit status: ${event.data.status}.`
        : "Rate limit event.",
      session_id: sessionId,
    };
  }
  return null;
}

function projectClaudeRecord(record, base) {
  if (record.type === "system" && record.subtype === "init") {
    return [
      makeEvent(base, "context", {
        model: optionalString(record.model),
        cwd: optionalString(record.cwd),
        permission: optionalString(record.permissionMode),
        tools: optionalNames(record.tools),
        agents: optionalNames(record.agents),
        skills: optionalNames(record.skills),
        plugins: optionalDescriptors(record.plugins),
        mcp_servers: optionalDescriptors(record.mcp_servers),
      }),
    ];
  }
  if (record.type === "assistant") {
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    const events = [];
    const content = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    if (content) events.push(makeEvent(base, "message", { role: "assistant", content }));
    for (const block of blocks) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        const argumentsValue = block.input ?? null;
        events.push(
          makeEvent(base, "tool-call", {
            ...toolCallData(block.name, argumentsValue, record.cwd),
            tool_call_id: optionalString(block.id),
          }),
        );
      }
    }
    return events;
  }
  if (record.type === "user") {
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    return blocks
      .filter((block) => block?.type === "tool_result")
      .map((block) =>
        makeEvent(base, "tool-result", {
          tool_call_id: optionalString(block.tool_use_id),
          status: block.is_error ? "failed" : "completed",
          output: contentText(block.content),
        }),
      );
  }
  if (record.type === "result") {
    return [
      makeEvent(base, "turn-end", {
        status: record.is_error ? "failed" : "completed",
        result: optionalString(record.result),
        usage: safeUsage(record.usage),
      }),
    ];
  }
  if (record.type === "rate_limit_event") {
    return [makeEvent(base, "rate-limit", { status: optionalString(record.rate_limit_info?.status) })];
  }
  return [];
}

function projectCodexRecord(record, base) {
  if (record.type === "thread.started") {
    return [makeEvent(base, "session", {})];
  }
  if (record.type === "turn.started") {
    return [makeEvent(base, "turn-start", { status: "running" })];
  }
  if (record.type === "turn.completed") {
    return [makeEvent(base, "turn-end", { status: "completed", usage: safeUsage(record.usage) })];
  }
  if (record.type === "turn.failed") {
    return [
      makeEvent(base, "turn-end", {
        status: "failed",
        result: optionalString(record.error?.message),
      }),
    ];
  }
  if (record.type === "error") {
    return [makeEvent(base, "error", { message: optionalString(record.message) })];
  }
  if (record.type !== "item.started" && record.type !== "item.completed") return [];
  const item = record.item ?? {};
  if (item.type === "agent_message" && record.type === "item.completed") {
    return [makeEvent(base, "message", { role: "assistant", content: optionalString(item.text) })];
  }
  if (item.type === "command_execution") {
    if (record.type === "item.started") {
      const argumentsValue = { command: optionalString(item.command) };
      return [
        makeEvent(base, "tool-call", {
          ...toolCallData("shell", argumentsValue, record.cwd),
          tool_call_id: optionalString(item.id),
        }),
      ];
    }
    return [
      makeEvent(base, "tool-result", {
        tool_call_id: optionalString(item.id),
        status: optionalString(item.status) ?? "completed",
        output: optionalString(item.aggregated_output ?? item.output),
        exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null,
      }),
    ];
  }
  if (item.type === "file_change" && record.type === "item.completed") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const argumentsValue = { changes, files: changes.map((change) => change?.path).filter(Boolean) };
    return [
      makeEvent(base, "tool-call", {
        ...toolCallData("file_change", argumentsValue, record.cwd),
        tool_call_id: optionalString(item.id),
        target_paths: changes.map((change) => change?.path).filter((path) => typeof path === "string"),
        arguments: { changes },
        status: optionalString(item.status) ?? "completed",
      }),
    ];
  }
  if (item.type === "mcp_tool_call") {
    const toolName = [item.server, item.tool].filter((part) => typeof part === "string").join("/");
    const common = {
      ...toolCallData(toolName || "mcp", item.arguments ?? null, record.cwd),
      tool_call_id: optionalString(item.id),
      tool_kind: "mcp",
    };
    return record.type === "item.started"
      ? [makeEvent(base, "tool-call", { ...common, arguments: item.arguments ?? null })]
      : [
          makeEvent(base, "tool-result", {
            ...common,
            status: optionalString(item.status) ?? "completed",
            output: item.result ?? null,
          }),
        ];
  }
  if (item.type === "web_search" && record.type === "item.completed") {
    return [
      makeEvent(base, "tool-call", {
        tool_call_id: optionalString(item.id),
        tool_name: "web_search",
        tool_kind: "search",
        arguments: { query: optionalString(item.query) },
        status: "completed",
      }),
    ];
  }
  return [];
}

function projectKimiRecord(record, base) {
  if (record.role === "assistant") {
    const events = [];
    if (typeof record.content === "string" && record.content.trim()) {
      events.push(makeEvent(base, "message", { role: "assistant", content: record.content.trim() }));
    }
    for (const call of Array.isArray(record.tool_calls) ? record.tool_calls : []) {
      const name = call?.function?.name;
      if (typeof name !== "string") continue;
      const argumentsValue = parseArguments(call.function?.arguments);
      events.push(
        makeEvent(base, "tool-call", {
          ...toolCallData(name, argumentsValue, record.cwd),
          tool_call_id: optionalString(call.id),
        }),
      );
    }
    return events;
  }
  if (record.role === "tool") {
    return [
      makeEvent(base, "tool-result", {
        tool_call_id: optionalString(record.tool_call_id),
        status: record.is_error ? "failed" : "completed",
        output: contentText(record.content),
      }),
    ];
  }
  if (record.role === "meta" && record.type === "session.resume_hint") {
    return [makeEvent(base, "turn-end", { status: "completed" })];
  }
  return [];
}

function projectMetadataEvent(event) {
  const projected = structuredClone(event);
  const data = projected.data ?? {};
  if (projected.kind === "context") {
    projected.data = compact({
      model: optionalString(data.model),
      cwd: optionalString(data.cwd),
      permission: optionalString(data.permission),
      effort: optionalString(data.effort),
      sandbox: optionalString(data.sandbox),
      provider: optionalString(data.provider),
      profile: optionalString(data.profile),
      entrypoint: optionalString(data.entrypoint),
      branch: optionalString(data.branch),
      commit: optionalString(data.commit),
      network_access:
        typeof data.network_access === "boolean" || typeof data.network_access === "string"
          ? data.network_access
          : undefined,
      add_dirs: optionalStringArray(data.add_dirs),
      tools: optionalNames(data.tools),
      disallowed_tools: optionalNames(data.disallowed_tools),
      tools_hash: optionalString(data.tools_hash),
      agents: optionalNames(data.agents),
      skills: optionalNames(data.skills),
      plugins: optionalDescriptors(data.plugins)?.map(({ name, source }) => compact({ name, source })),
      mcp_servers: optionalDescriptors(data.mcp_servers)?.map(({ name, status }) => compact({ name, status })),
      system_instruction_bytes: contentBytes(data.system_instructions),
      context_summary_bytes: contentBytes(data.context_summary),
    });
    return projected;
  }
  if (projected.kind === "message") {
    projected.data = compact({
      role: optionalString(data.role),
      content_bytes: contentBytes(data.content),
    });
    return projected;
  }
  if (projected.kind === "tool-call") {
    projected.data = compact({
      tool_call_id: optionalString(data.tool_call_id),
      tool_name: optionalString(data.tool_name),
      tool_kind: optionalString(data.tool_kind),
      status: optionalString(data.status),
      target_paths: stringArray(data.target_paths),
      resource_accesses: resourceAccessArray(data.resource_accesses),
      argument_bytes: contentBytes(data.arguments),
    });
    return projected;
  }
  if (projected.kind === "tool-result") {
    projected.data = compact({
      tool_call_id: optionalString(data.tool_call_id),
      tool_name: optionalString(data.tool_name),
      tool_kind: optionalString(data.tool_kind),
      status: optionalString(data.status),
      exit_code: Number.isInteger(data.exit_code) ? data.exit_code : undefined,
      output_bytes: contentBytes(data.output),
    });
    return projected;
  }
  if (projected.kind === "turn-start" || projected.kind === "turn-end") {
    projected.data = compact({
      status: optionalString(data.status),
      usage: safeUsage(data.usage),
      result_bytes: contentBytes(data.result),
    });
    return projected;
  }
  if (projected.kind === "model-call") {
    projected.data = compact({
      status: optionalString(data.status),
      model: optionalString(data.model),
      effort: optionalString(data.effort),
      usage: safeUsage(data.usage),
      duration_ms: Number.isFinite(data.duration_ms) ? data.duration_ms : undefined,
    });
    return projected;
  }
  if (projected.kind === "error") {
    projected.data = compact({
      code: optionalString(data.code),
      status: optionalString(data.status),
      message_bytes: contentBytes(data.message),
    });
    return projected;
  }
  if (projected.kind === "rate-limit") {
    projected.data = compact({ status: optionalString(data.status) });
    return projected;
  }
  projected.data = {};
  return projected;
}

function inferNativeSessionId(provider, records) {
  for (const record of records) {
    if (provider === "claude") {
      if (typeof record?.session_id === "string" && SESSION_ID_PATTERN.test(record.session_id)) {
        return record.session_id;
      }
    } else if (provider === "codex") {
      if (
        record?.type === "thread.started" &&
        typeof record.thread_id === "string" &&
        SESSION_ID_PATTERN.test(record.thread_id)
      ) {
        return record.thread_id;
      }
    } else if (provider === "opencode") {
      if (typeof record?.sessionID === "string" && SESSION_ID_PATTERN.test(record.sessionID)) {
        return record.sessionID;
      }
    } else if (
      record?.role === "meta" &&
      record.type === "session.resume_hint" &&
      typeof record.session_id === "string" &&
      SESSION_ID_PATTERN.test(record.session_id)
    ) {
      return record.session_id;
    }
  }
  return null;
}

function makeEvent(base, kind, data) {
  return { ...base, kind, data };
}

function nativeEventType(provider, record) {
  if (provider === "claude") return [record.type, record.subtype].filter(Boolean).join("/");
  if (provider === "codex") return [record.type, record.item?.type].filter(Boolean).join("/");
  if (provider === "opencode") return [record.type, record.part?.type].filter(Boolean).join("/");
  return [record.role, record.type].filter(Boolean).join("/");
}

function eventTimestamp(record) {
  for (const candidate of [record.timestamp, record.created_at, record.updated_at]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function safeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {};
  for (const [key, amount] of Object.entries(value)) {
    if ((key === "inputOther" || key === "output" ||
        /token|duration|cost|cache|call/i.test(key)) && Number.isFinite(amount)) {
      usage[key] = amount;
    }
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function names(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : item?.name))
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function optionalNames(value) {
  return Array.isArray(value) ? names(value) : undefined;
}

function descriptors(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? { name: item }
        : item && typeof item === "object"
          ? {
              name: optionalString(item.name),
              source: optionalString(item.source),
              status: optionalString(item.status),
              path: optionalString(item.path),
            }
          : null,
    )
    .filter((item) => item?.name);
}

function optionalDescriptors(value) {
  return Array.isArray(value) ? descriptors(value) : undefined;
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value ?? null;
  return value
    .map((item) => (typeof item === "string" ? item : item?.text ?? item?.content ?? ""))
    .join("");
}

function parseArguments(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function contentBytes(value) {
  if (value === undefined || value === null) return undefined;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(serialized);
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim());
}

function optionalStringArray(value) {
  return Array.isArray(value) ? stringArray(value) : undefined;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function classifyTool(name) {
  const value = String(name ?? "").toLowerCase();
  if (/bash|shell|exec|command/.test(value)) return "shell";
  if (/edit|write|patch|file_change/.test(value)) return "edit";
  if (/read|fetch/.test(value)) return "read";
  if (/search|find|grep/.test(value)) return "search";
  if (/web|http|browser|network/.test(value)) return "network";
  if (/mcp/.test(value)) return "mcp";
  return "other";
}

function toolCallData(name, argumentsValue, cwd = null) {
  const resourceAccesses = extractResourceAccesses({
    tool_name: name,
    arguments: argumentsValue,
    cwd,
  });
  return compact({
    tool_name: name,
    tool_kind: classifyTool(name),
    arguments: argumentsValue,
    resource_accesses: resourceAccesses.length > 0 ? resourceAccesses : undefined,
  });
}

function resourceAccessArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => compact({
      operation: optionalString(item.operation),
      path: optionalString(item.path),
      resource_kind: optionalString(item.resource_kind),
      evidence: optionalString(item.evidence),
      coverage: optionalString(item.coverage),
    }))
    .filter((item) => item.operation && item.path);
}

function boundInspectEvent(event) {
  const projected = structuredClone(event);
  const fields = [];
  projected.data = boundInspectValue(projected.data, "data", 0, fields);
  projected.provenance = boundInspectValue(projected.provenance, "provenance", 0, fields);
  if (fields.length > 0) projected.truncation = { truncated: true, fields };
  return projected;
}

function boundInspectValue(value, fieldPath, depth, fields) {
  if (typeof value === "string") {
    if (value.length <= AGENT_SESSION_INSPECT_LIMITS.string_chars) return value;
    fields.push({
      path: fieldPath,
      kind: "string",
      original_chars: value.length,
      original_bytes: Buffer.byteLength(value),
      retained_chars: AGENT_SESSION_INSPECT_LIMITS.string_chars,
    });
    return `${value.slice(0, AGENT_SESSION_INSPECT_LIMITS.string_chars)}\n… [truncated ${
      value.length - AGENT_SESSION_INSPECT_LIMITS.string_chars
    } chars]`;
  }
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (depth >= AGENT_SESSION_INSPECT_LIMITS.depth) {
    fields.push({ path: fieldPath, kind: "depth", original_count: 1, retained_count: 0 });
    return "[truncated: maximum inspect depth]";
  }
  if (Array.isArray(value)) {
    const retained = value.slice(0, AGENT_SESSION_INSPECT_LIMITS.array_items);
    if (retained.length < value.length) {
      fields.push({
        path: fieldPath,
        kind: "array",
        original_count: value.length,
        retained_count: retained.length,
      });
    }
    return retained.map((item, index) => boundInspectValue(item, `${fieldPath}[${index}]`, depth + 1, fields));
  }
  const entries = Object.entries(value);
  const retained = entries.slice(0, AGENT_SESSION_INSPECT_LIMITS.object_keys);
  if (retained.length < entries.length) {
    fields.push({
      path: fieldPath,
      kind: "object",
      original_count: entries.length,
      retained_count: retained.length,
    });
  }
  return Object.fromEntries(retained.map(([key, item]) => [
    key,
    boundInspectValue(item, `${fieldPath}.${key}`, depth + 1, fields),
  ]));
}

function providerLabel(provider) {
  return provider === "claude"
    ? "Claude"
    : provider === "codex"
      ? "Codex"
      : provider === "opencode"
        ? "OpenCode"
        : "Kimi";
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

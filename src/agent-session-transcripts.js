import {
  canonicalProvider,
  createContextObservation,
  createSessionEvent,
  parseJsonLines,
  projectSessionEvents,
} from "./agent-session-core.js";
import { createNativeEventReferenceProjector } from "./agent-session-references.js";
import { extractResourceAccesses } from "./agent-session-resources.js";

export function projectNativeTranscript(providerValue, input, options = {}) {
  const provider = canonicalProvider(providerValue);
  const records = Array.isArray(input) ? input : parseJsonLines(input);
  const nativeSessionId =
    options.native_session_id ?? inferTranscriptSessionId(provider, records) ?? null;
  const projector = createTranscriptProjector(provider, nativeSessionId);
  const referenceProjector = createNativeEventReferenceProjector(provider, nativeSessionId);
  let sequence = Number.isInteger(options.start_sequence) ? options.start_sequence : 0;
  const events = [];
  for (const record of records) {
    const referenced = referenceProjector.attach(record, projector.project(record));
    for (const event of referenced) {
      events.push({ ...event, sequence });
      sequence += 1;
    }
  }
  return projectSessionEvents(events, options.profile ?? "inspect");
}

export function createTranscriptProjector(providerValue, nativeSessionId) {
  const provider = canonicalProvider(providerValue);
  const state = {
    context: {},
    seenToolEvents: new Set(),
  };
  return {
    project(record) {
      if (!record || typeof record !== "object" || Array.isArray(record)) return [];
      if (provider === "claude") {
        return projectClaudeTranscriptRecord(record, provider, nativeSessionId, state);
      }
      if (provider === "codex") {
        return projectCodexTranscriptRecord(record, provider, nativeSessionId, state);
      }
      return projectKimiTranscriptRecord(record, provider, nativeSessionId, state);
    },
  };
}

function projectClaudeTranscriptRecord(record, provider, nativeSessionId, state) {
  const events = [];
  const context = compact({
    cwd: stringValue(record.cwd),
    branch: stringValue(record.gitBranch),
    permission: stringValue(record.permissionMode),
    model: stringValue(record.message?.model),
    effort: stringValue(record.effort),
    entrypoint: stringValue(record.entrypoint),
  });
  pushContext(events, state, provider, nativeSessionId, context, record, `claude/${record.type}`);

  const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
  if (record.type === "user") {
    const content =
      typeof record.message?.content === "string"
        ? record.message.content
        : textFromBlocks(blocks, new Set(["text", "input_text"]));
    if (content) {
      events.push(transcriptEvent(provider, nativeSessionId, "message", { role: "user", content }, record));
    }
    for (const block of blocks) {
      if (block?.type !== "tool_result") continue;
      events.push(
        transcriptEvent(
          provider,
          nativeSessionId,
          "tool-result",
          {
            tool_call_id: stringValue(block.tool_use_id),
            status: block.is_error ? "failed" : "completed",
            output: contentValue(block.content),
          },
          record,
        ),
      );
    }
  } else if (record.type === "assistant") {
    const content = textFromBlocks(blocks, new Set(["text", "output_text"]));
    if (content) {
      events.push(
        transcriptEvent(provider, nativeSessionId, "message", { role: "assistant", content }, record),
      );
    }
    for (const block of blocks) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      const argumentsValue = block.input ?? null;
      events.push(
        transcriptEvent(
          provider,
          nativeSessionId,
          "tool-call",
          {
            ...toolCallData(block.name, argumentsValue, state.context.cwd),
            tool_call_id: stringValue(block.id),
          },
          record,
        ),
      );
    }
  }
  return events;
}

function projectCodexTranscriptRecord(record, provider, nativeSessionId, state) {
  const payload = objectValue(record.payload);
  if (record.type === "session_meta") {
    const tools = Array.isArray(payload.dynamic_tools)
      ? flattenCodexTools(payload.dynamic_tools)
      : undefined;
    const git = objectValue(payload.git);
    const events = [];
    pushContext(
      events,
      state,
      provider,
      nativeSessionId,
      compact({
        cwd: stringValue(payload.cwd),
        provider: stringValue(payload.model_provider),
        entrypoint: stringValue(payload.originator),
        branch: stringValue(git.branch),
        commit: stringValue(git.commit_hash),
        system_instructions: stringValue(payload.base_instructions?.text),
        instruction_provenance: payload.base_instructions?.provenance ?? null,
        tools,
      }),
      record,
      "codex/session_meta",
    );
    return events;
  }
  if (record.type === "turn_context") {
    const context = compact({
      cwd: stringValue(payload.cwd),
      model: stringValue(payload.model),
      effort: stringValue(payload.effort),
      permission: stringValue(payload.approval_policy),
      sandbox: stringValue(
        payload.sandbox_policy?.mode ??
          payload.sandbox_policy?.type ??
          payload.file_system_sandbox_policy?.mode ??
          payload.file_system_sandbox_policy?.type,
      ),
      sandbox_policy: payload.sandbox_policy ?? payload.file_system_sandbox_policy ?? null,
      collaboration_mode: payload.collaboration_mode ?? null,
      context_summary: stringValue(payload.summary),
    });
    const events = [];
    pushContext(events, state, provider, nativeSessionId, context, record, "codex/turn_context");
    return events;
  }
  if (record.type === "event_msg") {
    const type = payload.type;
    if (["task_started", "turn_started"].includes(type)) {
      return [transcriptEvent(provider, nativeSessionId, "turn-start", { status: "running" }, record)];
    }
    if (["task_complete", "turn_complete"].includes(type)) {
      return [
        transcriptEvent(
          provider,
          nativeSessionId,
          "turn-end",
          { status: "completed", usage: safeUsage(payload.usage ?? payload.info?.last_token_usage) },
          record,
        ),
      ];
    }
    if (type === "turn_aborted") {
      return [
        transcriptEvent(provider, nativeSessionId, "turn-end", { status: "interrupted" }, record),
      ];
    }
    if (type === "token_count") {
      const usage = safeUsage(payload.info?.last_token_usage ?? payload.info?.total_token_usage);
      return usage
        ? [
            transcriptEvent(
              provider,
              nativeSessionId,
              "model-call",
              {
                status: "usage",
                model: stringValue(state.context.model),
                effort: stringValue(state.context.effort),
                usage,
              },
              record,
            ),
          ]
        : [];
    }
    return [];
  }
  if (record.type !== "response_item") return [];
  if (payload.type === "message") {
    const role = stringValue(payload.role);
    const content = textFromBlocks(payload.content, new Set(["input_text", "output_text", "text"]));
    if (!role || !content) return [];
    return [transcriptEvent(provider, nativeSessionId, "message", { role, content }, record)];
  }
  if (["function_call", "custom_tool_call"].includes(payload.type)) {
    const name = stringValue(payload.name ?? payload.namespace) ?? "tool";
    const argumentsValue = parseMaybeJson(payload.arguments ?? payload.input);
    return [
      transcriptEvent(
        provider,
        nativeSessionId,
        "tool-call",
        {
          ...toolCallData(name, argumentsValue, state.context.cwd),
          tool_call_id: stringValue(payload.call_id ?? payload.id),
          status: stringValue(payload.status),
        },
        record,
      ),
    ];
  }
  if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
    return [
      transcriptEvent(
        provider,
        nativeSessionId,
        "tool-result",
        {
          tool_call_id: stringValue(payload.call_id),
          status: "completed",
          output: contentValue(payload.output),
        },
        record,
      ),
    ];
  }
  return [];
}

function projectKimiTranscriptRecord(record, provider, nativeSessionId, state) {
  if (record.type === "profile.bind") {
    const events = [];
    pushContext(
      events,
      state,
      provider,
      nativeSessionId,
      compact({
        cwd: stringValue(record.environmentDisclosure?.cwd),
        model: stringValue(record.modelAlias),
        profile: stringValue(record.profileName),
        effort: stringValue(record.thinkingEffort),
        system_instructions: stringValue(record.systemPrompt),
        environment_disclosure: record.environmentDisclosure ?? null,
        instruction_paths: optionalStringArray(record.agentsMdPaths),
        tools: optionalStringArray(record.activeToolNames),
        disallowed_tools: optionalStringArray(record.disallowedTools),
      }),
      record,
      "kimi/profile.bind",
    );
    return events;
  }
  if (record.type === "permission.set_mode") {
    const events = [];
    pushContext(
      events,
      state,
      provider,
      nativeSessionId,
      { permission: stringValue(record.mode) },
      record,
      "kimi/permission.set_mode",
    );
    return events;
  }
  if (record.type === "llm.tools_snapshot") {
    const tools = Array.isArray(record.tools)
      ? record.tools.map((tool) => ({
          name: stringValue(tool?.name),
          description: stringValue(tool?.description),
          schema: tool?.parameters ?? null,
        }))
      : undefined;
    const events = [];
    pushContext(
      events,
      state,
      provider,
      nativeSessionId,
      { tools, tools_hash: stringValue(record.hash) },
      record,
      "kimi/llm.tools_snapshot",
    );
    return events;
  }
  if (record.type === "turn.prompt") {
    const content = textFromBlocks(record.input, new Set(["text", "input_text"]));
    return content
      ? [transcriptEvent(provider, nativeSessionId, "message", { role: "user", content }, record)]
      : [];
  }
  if (record.type === "context.append_message") {
    const message = objectValue(record.message);
    if (message.role !== "assistant") return [];
    const events = [];
    const content = textFromBlocks(message.content, new Set(["text", "output_text"]));
    if (content) {
      events.push(
        transcriptEvent(provider, nativeSessionId, "message", { role: "assistant", content }, record),
      );
    }
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const name = stringValue(call?.name ?? call?.function?.name);
      if (!name) continue;
      const argumentsValue = call.args ?? parseMaybeJson(call.function?.arguments);
      events.push(
        transcriptEvent(
          provider,
          nativeSessionId,
          "tool-call",
          {
            ...toolCallData(name, argumentsValue, state.context.cwd),
            tool_call_id: stringValue(call.id ?? call.toolCallId),
          },
          record,
        ),
      );
    }
    return events;
  }
  if (record.type === "context.append_loop_event") {
    const event = objectValue(record.event);
    if (event.type === "tool.call") {
      const key = `call:${event.toolCallId}`;
      if (event.toolCallId && state.seenToolEvents.has(key)) return [];
      if (event.toolCallId) state.seenToolEvents.add(key);
      const name = stringValue(event.name) ?? "tool";
      const argumentsValue = event.args ?? null;
      return [
        transcriptEvent(
          provider,
          nativeSessionId,
          "tool-call",
          {
            ...toolCallData(name, argumentsValue, state.context.cwd),
            tool_call_id: stringValue(event.toolCallId),
          },
          record,
        ),
      ];
    }
    if (event.type === "tool.result") {
      const key = `result:${event.toolCallId}`;
      if (event.toolCallId && state.seenToolEvents.has(key)) return [];
      if (event.toolCallId) state.seenToolEvents.add(key);
      return [
        transcriptEvent(
          provider,
          nativeSessionId,
          "tool-result",
          {
            tool_call_id: stringValue(event.toolCallId),
            status: event.result?.isError ? "failed" : "completed",
            output: event.result ?? null,
          },
          record,
        ),
      ];
    }
    if (event.type === "step.end") {
      return [
        transcriptEvent(
          provider,
          nativeSessionId,
          "model-call",
          {
            status: "completed",
            usage: safeUsage(event.usage),
            duration_ms: numberValue(event.llmClientConsumeMs),
          },
          record,
        ),
      ];
    }
    return [];
  }
  if (record.type === "llm.request") {
    return [
      transcriptEvent(
        provider,
        nativeSessionId,
        "model-call",
        {
          status: "started",
          model: stringValue(record.model),
          effort: stringValue(record.thinkingEffort),
        },
        record,
      ),
    ];
  }
  if (record.type === "usage.record") {
    return [
      transcriptEvent(
        provider,
        nativeSessionId,
        "model-call",
        { status: "usage", model: stringValue(record.model), usage: safeUsage(record.usage) },
        record,
      ),
    ];
  }
  return [];
}

function pushContext(events, state, provider, nativeSessionId, context, record, nativeType) {
  if (!context || Object.keys(context).length === 0) return;
  const delta = {};
  for (const [key, value] of Object.entries(context)) {
    if (JSON.stringify(state.context[key]) !== JSON.stringify(value)) delta[key] = value;
  }
  if (Object.keys(delta).length === 0) return;
  state.context = { ...state.context, ...delta };
  events.push(contextObservation(provider, nativeSessionId, delta, record, nativeType));
}

function contextObservation(provider, nativeSessionId, context, record, nativeType) {
  return createContextObservation({
    provider,
    native_session_id: nativeSessionId,
    context,
    occurred_at: transcriptTimestamp(record),
    stage: "observed",
    source: "native-transcript",
    native_type: nativeType,
  });
}

function transcriptEvent(provider, nativeSessionId, kind, data, record) {
  return createSessionEvent({
    provider,
    native_session_id: nativeSessionId,
    kind,
    data: compact(data),
    occurred_at: transcriptTimestamp(record),
    stage: "observed",
    source: "native-transcript",
    native_type: `${provider}/${record.type ?? record.role ?? "record"}`,
  });
}

function inferTranscriptSessionId(provider, records) {
  for (const record of records) {
    const value =
      provider === "claude"
        ? record?.sessionId ?? record?.session_id
        : provider === "codex"
          ? record?.type === "session_meta"
            ? record.payload?.id ?? record.payload?.session_id
            : null
          : record?.session_id ?? record?.sessionId;
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function flattenCodexTools(value) {
  if (!Array.isArray(value)) return [];
  const tools = [];
  for (const item of value) {
    if (Array.isArray(item?.tools)) {
      for (const nested of item.tools) {
        if (typeof nested === "string") tools.push({ name: nested });
        else if (nested && typeof nested === "object") tools.push(structuredClone(nested));
      }
    } else if (typeof item === "string") {
      tools.push({ name: item });
    } else if (item && typeof item === "object") {
      tools.push(structuredClone(item));
    }
  }
  return tools;
}

function textFromBlocks(value, allowedTypes) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => block && typeof block === "object" && allowedTypes.has(block.type))
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

function contentValue(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value ?? null;
  const text = textFromBlocks(value, new Set(["text", "input_text", "output_text"]));
  return text || structuredClone(value);
}

function transcriptTimestamp(record) {
  for (const candidate of [record.timestamp, record.time, record.created_at]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (Number.isFinite(candidate)) {
      const millis = candidate > 100000000000 ? candidate : candidate * 1000;
      return new Date(millis).toISOString();
    }
  }
  return null;
}

function safeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {};
  for (const [key, amount] of Object.entries(value)) {
    if (/token|duration|cost|cache|call/i.test(key) && Number.isFinite(amount)) usage[key] = amount;
  }
  return Object.keys(usage).length > 0 ? usage : null;
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

function toolCallData(name, argumentsValue, cwd) {
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

function parseMaybeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

function optionalStringArray(value) {
  return Array.isArray(value) ? stringArray(value) : undefined;
}

function numberValue(value) {
  return Number.isFinite(value) ? value : null;
}

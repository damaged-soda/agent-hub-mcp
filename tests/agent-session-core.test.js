import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_SESSION_INSPECT_LIMITS,
  AGENT_SESSION_SCHEMA_VERSION,
  canonicalProvider,
  createContextObservation,
  createSessionEvent,
  createSessionIdentity,
  projectLiveRecord,
  projectLiveStream,
  projectSessionEvents,
  sessionRefFromLiveEvent,
  summarizeLiveRecord,
} from "../src/agent-session-core.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "agent-session",
);

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

describe("agent session identity", () => {
  it("normalizes agent ids without making Agent Hub the session owner", () => {
    expect(canonicalProvider("claude-code")).toBe("claude");
    expect(canonicalProvider("codex")).toBe("codex");
    expect(canonicalProvider("kimi-code")).toBe("kimi");
    expect(createSessionIdentity("codex", "thread-1")).toEqual({
      provider: "codex",
      native_session_id: "thread-1",
    });
  });

  it("allows an unknown native id while a provider has not reported it", () => {
    expect(createSessionIdentity("kimi", null)).toEqual({
      provider: "kimi",
      native_session_id: null,
    });
  });

  it("rejects unsupported providers and unsafe session ids", () => {
    expect(() => canonicalProvider("agenthub")).toThrow(/Unsupported/);
    expect(() => createSessionIdentity("codex", "../escape")).toThrow(/native_session_id/);
  });
});

describe("context provenance", () => {
  it("represents requested and launched context independently from observed context", () => {
    const requested = createContextObservation({
      provider: "claude",
      native_session_id: "session-1",
      stage: "requested",
      source: "agenthub-request",
      context: { model: "sonnet", permission: "read-only" },
    });
    const launched = createContextObservation({
      provider: "claude",
      native_session_id: "session-1",
      stage: "launched",
      source: "agenthub-command",
      context: { model: "sonnet", permission: "plan" },
    });

    expect(requested.provenance.stage).toBe("requested");
    expect(launched.provenance.stage).toBe("launched");
    expect(requested.data.permission).toBe("read-only");
    expect(launched.data.permission).toBe("plan");
    const metadata = projectSessionEvents(
      [
        createContextObservation({
          provider: "claude",
          native_session_id: "session-1",
          stage: "requested",
          source: "agenthub-request",
          context: {
            model: "sonnet",
            permission: "read-only",
            prompt: "must not persist",
            system_instructions: "also private",
          },
        }),
      ],
      "metadata",
    );
    expect(metadata[0].data).toEqual({
      model: "sonnet",
      permission: "read-only",
      system_instruction_bytes: 12,
    });
    expect(JSON.stringify(metadata)).not.toContain("must not persist");
    expect(() =>
      createContextObservation({
        provider: "claude",
        context: {},
        occurred_at: 123,
      }),
    ).toThrow(/occurred_at/);
  });
});

describe("provider conformance fixtures", () => {
  it("projects Claude init, messages and tools while ignoring thinking blocks", () => {
    const events = projectLiveStream("claude", fixture("claude-live.jsonl"));
    const context = events.find((event) => event.kind === "context");
    const message = events.find((event) => event.kind === "message");
    const tool = events.find((event) => event.kind === "tool-call");

    expect(events.every((event) => event.schema_version === AGENT_SESSION_SCHEMA_VERSION)).toBe(true);
    expect(context.data).toMatchObject({
      model: "claude-opus-test",
      permission: "plan",
      tools: ["Read", "Bash"],
      agents: ["reviewer"],
      skills: ["agent-hub"],
    });
    expect(message.data.content).toBe("I will inspect it.");
    expect(JSON.stringify(events)).not.toContain("hidden reasoning");
    expect(tool.data).toMatchObject({
      tool_call_id: "tool-1",
      tool_name: "Bash",
      tool_kind: "shell",
      arguments: { command: "git status --short" },
    });
    expect(events.at(-1).data.status).toBe("completed");
  });

  it("projects Codex lifecycle and propagates the native thread id", () => {
    const events = projectLiveStream("codex", fixture("codex-live.jsonl"));
    expect(events.map((event) => event.kind)).toEqual([
      "session",
      "turn-start",
      "tool-call",
      "tool-result",
      "tool-call",
      "message",
      "turn-end",
    ]);
    expect(new Set(events.map((event) => event.native_session_id))).toEqual(
      new Set(["01a03dc9-2a7e-76a2-b03d-39e06e22a5b6"]),
    );
    expect(events.find((event) => event.data.tool_kind === "edit").data.target_paths).toEqual([
      "src/example.js",
    ]);
  });

  it("projects Kimi tools before the terminal resume hint reports its session id", () => {
    const events = projectLiveStream("kimi", fixture("kimi-live.jsonl"));
    expect(events.every((event) => event.native_session_id?.startsWith("session_"))).toBe(true);
    expect(events.find((event) => event.kind === "tool-call").data.arguments).toEqual({
      command: "git status --short",
    });
    expect(events.at(-1)).toMatchObject({ kind: "turn-end", data: { status: "completed" } });
  });

  it("creates a content-free metadata projection with size evidence", () => {
    const events = projectLiveStream("claude", fixture("claude-live.jsonl"), {
      profile: "metadata",
    });
    const serialized = JSON.stringify(events);
    const context = events.find((event) => event.kind === "context");
    const message = events.find((event) => event.kind === "message");
    const tool = events.find((event) => event.kind === "tool-call");

    expect(serialized).not.toContain("I will inspect it.");
    expect(serialized).not.toContain("git status --short");
    expect(serialized).not.toContain("clean\\n");
    expect(serialized).not.toContain("Looks good.");
    expect(serialized).not.toContain("/private/plugin");
    expect(message.data.content_bytes).toBeGreaterThan(0);
    expect(tool.data.argument_bytes).toBeGreaterThan(0);
    expect(context.data.plugins).toEqual([{ name: "feature-dev", source: "marketplace" }]);
    expect(context.data.mcp_servers).toEqual([{ name: "docs", status: "connected" }]);
  });

  it("bounds inspect bodies and reports exact truncation provenance", () => {
    const content = "x".repeat(AGENT_SESSION_INSPECT_LIMITS.string_chars + 17);
    const [event] = projectSessionEvents([
      createSessionEvent({
        provider: "codex",
        native_session_id: "thread-1",
        kind: "message",
        data: { role: "assistant", content },
      }),
    ], "inspect");
    expect(event.data.content).toContain("[truncated 17 chars]");
    expect(event.truncation).toMatchObject({
      truncated: true,
      fields: [{
        path: "data.content",
        kind: "string",
        original_chars: content.length,
        retained_chars: AGENT_SESSION_INSPECT_LIMITS.string_chars,
      }],
    });
  });
});

describe("live adapter helpers", () => {
  it("extracts a Codex session ref through the shared provider contract", () => {
    expect(
      sessionRefFromLiveEvent("codex", {
        type: "thread.started",
        thread_id: "01a03dc9-2a7e-76a2-b03d-39e06e22a5b6",
      }),
    ).toEqual({
      agent_id: "codex",
      native_session_id: "01a03dc9-2a7e-76a2-b03d-39e06e22a5b6",
    });
  });

  it("summarizes provider records without knowing the Agent Hub run id", () => {
    const summary = summarizeLiveRecord({
      role: "assistant",
      tool_calls: [
        { id: "a", function: { name: "Read", arguments: "{}" } },
        { id: "b", function: { name: "Bash", arguments: "{}" } },
      ],
    });
    expect(summary.message).toBe("Using tools: Read, Bash.");
    expect(
      summarizeLiveRecord({
        type: "thread.started",
        thread_id: "01a03dc9-2a7e-76a2-b03d-39e06e22a5b6",
      }).message,
    ).toBe("Codex session started.");
    expect(summarizeLiveRecord({ type: "error", message: "boom" }).message).toBe("boom");
    expect(
      summarizeLiveRecord({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Here is my plan." },
            { type: "tool_use", id: "a", name: "Read", input: {} },
            { type: "tool_use", id: "b", name: "Grep", input: {} },
          ],
        },
      }).message,
    ).toBe("Here is my plan.");
  });

  it("projects individual live records as schema-shaped events", () => {
    const [event] = projectLiveRecord("codex", {
      type: "thread.started",
      thread_id: "01a03dc9-2a7e-76a2-b03d-39e06e22a5b6",
    });
    expect(event).toMatchObject({ schema_version: 1, sequence: 0, kind: "session" });
  });
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectNativeTranscript } from "../src/agent-session-transcripts.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "agent-session",
);

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

describe("native transcript projections", () => {
  it("projects Claude prompts and tools without exposing thinking", () => {
    const events = projectNativeTranscript("claude", fixture("claude-transcript.jsonl"));
    expect(events.find((event) => event.data.role === "user").data.content).toBe(
      "Review this change.",
    );
    expect(events.find((event) => event.kind === "tool-call").data.arguments).toEqual({
      command: "git status --short",
    });
    const modelCalls = events.filter((event) => event.kind === "model-call");
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0].data).toMatchObject({
      status: "completed",
      model: "claude-opus-test",
      effort: "high",
      usage: {
        input_tokens: 11,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
        output_tokens: 7,
        reasoning_tokens: 2,
      },
    });
    expect(modelCalls[0].data.usage).not.toHaveProperty("total_tokens");
    expect(modelCalls[0].occurred_at).toBe("2026-08-26T10:00:01.100Z");
    expect(JSON.stringify(events)).not.toContain("hidden reasoning");
  });

  it("does not expose a partial Claude usage snapshot as a completed model call", () => {
    const events = projectNativeTranscript("claude", [{
      type: "assistant",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      message: {
        id: "msg-interrupted",
        role: "assistant",
        model: "claude-test",
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 1 },
        content: [],
      },
    }]);
    expect(events.filter((event) => event.kind === "model-call")).toHaveLength(0);
  });

  it("deduplicates Claude usage by request id when message id is absent", () => {
    const record = {
      type: "assistant",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      requestId: "request-without-message-id",
      message: {
        role: "assistant",
        model: "claude-test",
        usage: { input_tokens: 3, output_tokens: 2 },
        content: [],
      },
    };
    const events = projectNativeTranscript("claude", [record, structuredClone(record)]);
    expect(events.filter((event) => event.kind === "model-call")).toHaveLength(1);
  });

  it("projects Codex base/developer prompts, context and tools", () => {
    const events = projectNativeTranscript("codex", fixture("codex-transcript.jsonl"));
    const contexts = events.filter((event) => event.kind === "context");
    const messages = events.filter((event) => event.kind === "message");
    expect(contexts[0].data.system_instructions).toBe("Private base instructions");
    expect(contexts[0].data.tools[0].name).toBe("Bash");
    expect(messages.map((event) => event.data.role)).toEqual(["developer", "user", "assistant"]);
    expect(events.find((event) => event.kind === "tool-call").data.arguments).toEqual({
      command: "git status --short",
    });
    expect(events.find((event) => event.kind === "model-call").data).toMatchObject({
      model: "gpt-test",
      effort: "high",
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    });
  });

  it("projects Kimi profile/tool snapshots and transcript events", () => {
    const events = projectNativeTranscript("kimi", fixture("kimi-transcript.jsonl"), {
      native_session_id: "session_437f4ac7-19f4-472b-be3c-a87be0f41419",
    });
    expect(events.find((event) => event.data.system_instructions).data).toMatchObject({
      model: "k3",
      tools: ["Read", "Bash"],
      system_instructions: "Private Kimi system prompt",
    });
    expect(events.find((event) => event.kind === "tool-call").data.arguments).toEqual({
      command: "git status --short",
    });
    expect(events.find((event) =>
      event.provenance.native_type === "kimi/usage.record").data).toMatchObject({
      model: "k3",
      usage: {
        inputOther: 10,
        inputCacheRead: 90,
        inputCacheCreation: 2,
        output: 3,
      },
    });
    expect(events.find((event) =>
      event.provenance.native_type === "kimi/context.append_loop_event" &&
      event.kind === "model-call").data).toMatchObject({
      status: "completed",
      usage: {
        inputOther: 10,
        inputCacheRead: 90,
        inputCacheCreation: 2,
        output: 3,
      },
      duration_ms: 12,
    });
  });

  it("projects OpenCode exports while excluding reasoning", () => {
    const events = projectNativeTranscript("opencode", fixture("opencode-export.json"));
    expect(events.find((event) => event.kind === "context").data).toMatchObject({
      cwd: "/workspace/example",
      provider: "zai-coding-plan",
      model: "glm-5.3-flash",
      effort: "max",
      profile: "build",
    });
    expect(events.filter((event) => event.kind === "message").map((event) => event.data.role))
      .toEqual(["user", "assistant"]);
    expect(events.find((event) => event.kind === "tool-call").data).toMatchObject({
      tool_call_id: "call_opencode_1",
      tool_name: "bash",
      arguments: { command: "git status --short", workdir: "/workspace/example" },
    });
    expect(events.find((event) => event.kind === "tool-result").data).toMatchObject({
      tool_call_id: "call_opencode_1",
      status: "completed",
      exit_code: 0,
      output: "clean\n",
    });
    expect(events.find((event) => event.kind === "model-call").data.usage).toMatchObject({
      total_tokens: 21,
      input_tokens: 16,
      output_tokens: 5,
    });
    expect(JSON.stringify(events)).not.toContain("hidden OpenCode reasoning");
  });

  it("keeps OpenCode session and message refs stable across mutable usage totals", () => {
    const original = JSON.parse(fixture("opencode-export.json"));
    const updated = structuredClone(original);
    updated.info.time.updated += 1000;
    updated.info.cost += 1;
    updated.messages[1].info.tokens.input += 100;
    updated.messages[1].info.time.completed += 1000;
    const first = projectNativeTranscript("opencode", original);
    const second = projectNativeTranscript("opencode", updated);
    const select = (events, kind, role) => events.find((event) =>
      event.kind === kind && (!role || event.data.role === role));
    expect(select(second, "context").event_ref).toBe(select(first, "context").event_ref);
    expect(select(second, "message", "user").event_ref)
      .toBe(select(first, "message", "user").event_ref);
  });

  it("removes all transcript body fields from metadata projections", () => {
    for (const [provider, name, nativeSessionId] of [
      ["claude", "claude-transcript.jsonl", undefined],
      ["codex", "codex-transcript.jsonl", undefined],
      ["kimi", "kimi-transcript.jsonl", "session_437f4ac7-19f4-472b-be3c-a87be0f41419"],
      ["opencode", "opencode-export.json", "ses_01a03dc9bffezOpenCodeFixture"],
    ]) {
      const events = projectNativeTranscript(provider, fixture(name), {
        native_session_id: nativeSessionId,
        profile: "metadata",
      });
      const serialized = JSON.stringify(events);
      for (const secret of [
        "Review this change.",
        "Private",
        "git status --short",
        "clean\\n",
        "Looks good.",
      ]) {
        expect(serialized).not.toContain(secret);
      }
      expect(events.some((event) => event.data.content_bytes > 0)).toBe(true);
      if (["codex", "kimi"].includes(provider)) {
        expect(events.some((event) => event.data.system_instruction_bytes > 0)).toBe(true);
      }
      if (provider === "kimi") {
        expect(events.some((event) =>
          event.kind === "model-call" && event.data.usage?.inputOther === 10 &&
          event.data.usage?.output === 3)).toBe(true);
      }
    }
  });

  it("does not turn missing context arrays into observed empty sets", () => {
    const events = projectNativeTranscript("codex", fixture("codex-transcript.jsonl"), {
      profile: "metadata",
    });
    const contexts = events.filter((event) => event.kind === "context");
    expect(contexts[0].data.tools).toEqual(["Bash"]);
    expect(contexts[1].data).not.toHaveProperty("tools");
  });

  it("marks the exact transcript step that read a file", () => {
    const records = [
      { type: "session_meta", timestamp: "2026-08-26T10:00:00Z", payload: {
        id: "01a03dc9-2a7e-76a2-b03d-39e06e22a5b6", cwd: "/workspace/example",
      } },
      { type: "response_item", timestamp: "2026-08-26T10:00:01Z", payload: {
        type: "custom_tool_call", call_id: "call-read", name: "exec",
        input: String.raw`const r = await tools.exec_command({"cmd":"sed -n '1,40p' docs/guide.md","workdir":"/workspace/example"});`,
      } },
    ];
    const events = projectNativeTranscript("codex", records);
    const call = events.find((event) => event.kind === "tool-call");
    expect(call.data.resource_accesses).toEqual([{
      operation: "read",
      path: "/workspace/example/docs/guide.md",
      resource_kind: "file",
      evidence: "shell-explicit-operand",
      coverage: "high-confidence",
    }]);
    const metadata = projectNativeTranscript("codex", records, { profile: "metadata" });
    expect(metadata.find((event) => event.kind === "tool-call").data.resource_accesses)
      .toEqual(call.data.resource_accesses);
    expect(JSON.stringify(metadata)).not.toContain("sed -n");
  });

  it("keeps native event references identical across content profiles and sequence cursors", () => {
    const transcript = fixture("codex-transcript.jsonl");
    const inspect = projectNativeTranscript("codex", transcript, { start_sequence: 0 });
    const metadata = projectNativeTranscript("codex", transcript, {
      profile: "metadata",
      start_sequence: 900,
    });
    expect(inspect.every((event) => event.event_ref?.startsWith("agenthub://session/v1/")))
      .toBe(true);
    expect(metadata.map((event) => event.event_ref)).toEqual(
      inspect.map((event) => event.event_ref),
    );
    expect(metadata.map((event) => event.sequence)).not.toEqual(
      inspect.map((event) => event.sequence),
    );

    const records = transcript.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const withUnrelatedRecord = projectNativeTranscript("codex", [
      { type: "unprojected.future-record", value: true },
      ...records,
    ]);
    const target = (events) => events.find((event) =>
      event.kind === "tool-call" && event.data.tool_call_id === "call-1"
    );
    expect(target(withUnrelatedRecord).event_ref).toBe(target(inspect).event_ref);
  });
});

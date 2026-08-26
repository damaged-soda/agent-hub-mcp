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
    expect(JSON.stringify(events)).not.toContain("hidden reasoning");
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
    expect(events.find((event) => event.kind === "model-call").data.model).toBe("k3");
  });

  it("removes all transcript body fields from metadata projections", () => {
    for (const [provider, name, nativeSessionId] of [
      ["claude", "claude-transcript.jsonl", undefined],
      ["codex", "codex-transcript.jsonl", undefined],
      ["kimi", "kimi-transcript.jsonl", "session_437f4ac7-19f4-472b-be3c-a87be0f41419"],
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
      if (provider !== "claude") {
        expect(events.some((event) => event.data.system_instruction_bytes > 0)).toBe(true);
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
});

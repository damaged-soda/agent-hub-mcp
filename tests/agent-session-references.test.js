import { describe, expect, it } from "vitest";
import { createSessionEvent } from "../src/agent-session-core.js";
import {
  attachNativeEventReferences,
  createNativeEventReferenceProjector,
  formatAgentSessionEventReference,
  formatAgentSessionReference,
  parseAgentSessionReference,
  parseAgentSessionEventReference,
} from "../src/agent-session-references.js";

const SESSION_ID = "thread:stable-1";
const RECORD = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "call-1", name: "Read", input: { path: "README.md" } },
    ],
  },
};

function event(kind, data) {
  return createSessionEvent({
    provider: "codex",
    native_session_id: SESSION_ID,
    kind,
    data,
  });
}

describe("Agent Session event references", () => {
  it("round-trips a canonical session-level v1 URI", () => {
    const reference = formatAgentSessionReference({
      provider: "codex",
      native_session_id: SESSION_ID,
    });
    expect(reference).toBe("agenthub://session/v1/codex/thread%3Astable-1");
    expect(parseAgentSessionReference(reference)).toEqual({
      reference_version: 1,
      reference_kind: "session",
      provider: "codex",
      native_session_id: SESSION_ID,
      reference,
    });
    expect(() => parseAgentSessionEventReference(reference)).toThrow(/include an event id/);
    expect(() => parseAgentSessionReference(`${reference}/`)).toThrow(/canonical/);
    expect(() => parseAgentSessionReference(reference.replace("%3A", "%3a"))).toThrow(/canonical/);
  });

  it("round-trips one canonical self-contained v1 URI", () => {
    const reference = formatAgentSessionEventReference({
      provider: "codex",
      native_session_id: SESSION_ID,
      event_id: `e1_${"a".repeat(43)}`,
    });
    expect(reference).toBe(
      `agenthub://session/v1/codex/thread%3Astable-1/event/e1_${"a".repeat(43)}`,
    );
    expect(parseAgentSessionEventReference(reference)).toEqual({
      reference_version: 1,
      provider: "codex",
      native_session_id: SESSION_ID,
      event_id: `e1_${"a".repeat(43)}`,
      reference,
    });
    expect(parseAgentSessionReference(reference).reference_kind).toBe("event");
  });

  it("rejects non-canonical, unsupported, and decorated references", () => {
    const eventId = `e1_${"b".repeat(43)}`;
    expect(() => parseAgentSessionEventReference(
      `agenthub://session/v2/codex/session-1/event/${eventId}`,
    )).toThrow(/version or shape/);
    expect(() => parseAgentSessionEventReference(
      `agenthub://session/v1/codex/session-1/event/${eventId}?source=macmini`,
    )).toThrow(/Invalid/);
    expect(() => parseAgentSessionEventReference(
      `agenthub://session/v1/claude-code/session-1/event/${eventId}`,
    )).toThrow(/canonical/);
  });

  it("keeps an event reference stable when projection sequence or sibling kinds change", () => {
    const target = event("tool-call", {
      tool_call_id: "call-1",
      tool_name: "Read",
      arguments: { path: "README.md" },
    });
    const first = attachNativeEventReferences([target], {
      provider: "codex",
      native_session_id: SESSION_ID,
      record_occurrence: 0,
      record: RECORD,
    })[0];
    const withNewProjection = attachNativeEventReferences([
      event("context", { cwd: "/workspace" }),
      event("message", { role: "assistant", content: "Checking." }),
      { ...target, sequence: 999 },
    ], {
      provider: "codex",
      native_session_id: SESSION_ID,
      record_occurrence: 0,
      record: RECORD,
    })[2];
    expect(withNewProjection.event_ref).toBe(first.event_ref);
  });

  it("invalidates rewritten evidence and disambiguates duplicate native records", () => {
    const target = event("message", { role: "assistant", content: "Checking." });
    const reference = (record) => attachNativeEventReferences([target], {
      provider: "codex",
      native_session_id: SESSION_ID,
      record_occurrence: 0,
      record,
    })[0].event_ref;
    expect(reference(RECORD)).not.toBe(reference({ ...RECORD, changed: true }));
    expect(reference({ type: "assistant", value: 1 })).toBe(
      reference({ value: 1, type: "assistant" }),
    );

    const projector = createNativeEventReferenceProjector("codex", SESSION_ID);
    const first = projector.attach(RECORD, [target])[0].event_ref;
    const duplicate = projector.attach(RECORD, [target])[0].event_ref;
    expect(duplicate).not.toBe(first);
  });
});

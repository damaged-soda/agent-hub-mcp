import { createHash } from "node:crypto";
import { canonicalProvider, createSessionIdentity } from "./agent-session-core.js";

export const AGENT_SESSION_REFERENCE_VERSION = 1;
export const AGENT_SESSION_EVENT_ID_VERSION = 1;

const EVENT_ID_PATTERN = /^e1_[A-Za-z0-9_-]{43}$/;
const RECORD_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function formatAgentSessionReference(input) {
  const identity = createSessionIdentity(input?.provider, input?.native_session_id);
  if (!identity.native_session_id) throw new Error("native_session_id is required");
  return `agenthub://session/v${AGENT_SESSION_REFERENCE_VERSION}/${identity.provider}/${
    encodeURIComponent(identity.native_session_id)
  }`;
}

export function formatAgentSessionEventReference(input) {
  if (typeof input?.event_id !== "string" || !EVENT_ID_PATTERN.test(input.event_id)) {
    throw new Error("event_id must be a stable Agent Session event id");
  }
  return `${formatAgentSessionReference(input)}/event/${input.event_id}`;
}

export function parseAgentSessionReference(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("Agent Session reference must be a non-empty string");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid Agent Session reference");
  }
  if (
    parsed.protocol !== "agenthub:" ||
    parsed.hostname !== "session" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Invalid Agent Session reference");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    (segments.length !== 3 && segments.length !== 5) ||
    segments[0] !== `v${AGENT_SESSION_REFERENCE_VERSION}` ||
    (segments.length === 5 && segments[3] !== "event")
  ) {
    throw new Error("Unsupported Agent Session reference version or shape");
  }
  let nativeSessionId;
  try {
    nativeSessionId = decodeURIComponent(segments[2]);
  } catch {
    throw new Error("Invalid Agent Session reference encoding");
  }
  const provider = canonicalProvider(segments[1]);
  if (provider !== segments[1]) {
    throw new Error("Agent Session reference provider is not canonical");
  }
  const identity = createSessionIdentity(provider, nativeSessionId);
  if (segments.length === 3) {
    const reference = formatAgentSessionReference(identity);
    if (reference !== value) throw new Error("Agent Session reference is not canonical");
    return {
      reference_version: AGENT_SESSION_REFERENCE_VERSION,
      reference_kind: "session",
      ...identity,
      reference,
    };
  }
  const eventId = segments[4];
  if (!EVENT_ID_PATTERN.test(eventId)) {
    throw new Error("Invalid Agent Session event id");
  }
  const reference = formatAgentSessionEventReference({ ...identity, event_id: eventId });
  if (reference !== value) throw new Error("Agent Session event reference is not canonical");
  return {
    reference_version: AGENT_SESSION_REFERENCE_VERSION,
    reference_kind: "event",
    ...identity,
    event_id: eventId,
    reference,
  };
}

export function parseAgentSessionEventReference(value) {
  const parsed = parseAgentSessionReference(value);
  if (parsed.reference_kind !== "event") {
    throw new Error("Agent Session event reference must include an event id");
  }
  const { reference_kind: _referenceKind, ...eventReference } = parsed;
  return eventReference;
}

export function attachNativeEventReferences(events, input) {
  if (!Array.isArray(events)) throw new Error("events must be an array");
  const identity = createSessionIdentity(input?.provider, input?.native_session_id ?? null);
  if (!identity.native_session_id) return events;
  if (!Number.isInteger(input?.record_occurrence) || input.record_occurrence < 0) {
    throw new Error("record_occurrence must be a non-negative integer");
  }
  if (!input?.record || typeof input.record !== "object" || Array.isArray(input.record)) {
    throw new Error("record must be a provider-native object");
  }
  const recordDigest = input.record_digest ?? sha256(canonicalJson(input.record));
  if (typeof recordDigest !== "string" || !RECORD_DIGEST_PATTERN.test(recordDigest)) {
    throw new Error("record_digest must be a lowercase SHA-256 digest");
  }
  const occurrences = new Map();
  return events.map((event) => {
    const selector = eventSelector(event);
    const occurrence = occurrences.get(selector) ?? 0;
    occurrences.set(selector, occurrence + 1);
    const eventId = `e${AGENT_SESSION_EVENT_ID_VERSION}_${digestParts([
      `reference-v${AGENT_SESSION_REFERENCE_VERSION}`,
      identity.provider,
      identity.native_session_id,
      recordDigest,
      String(input.record_occurrence),
      selector,
      String(occurrence),
    ])}`;
    return {
      ...event,
      event_ref: formatAgentSessionEventReference({ ...identity, event_id: eventId }),
    };
  });
}

export function createNativeEventReferenceProjector(providerValue, nativeSessionId) {
  const identity = createSessionIdentity(providerValue, nativeSessionId);
  const recordOccurrences = new Map();
  return {
    attach(record, events) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error("record must be a provider-native object");
      }
      const recordDigest = sha256(canonicalJson(record));
      const recordOccurrence = recordOccurrences.get(recordDigest) ?? 0;
      recordOccurrences.set(recordDigest, recordOccurrence + 1);
      return attachNativeEventReferences(events, {
        ...identity,
        record_digest: recordDigest,
        record_occurrence: recordOccurrence,
        record,
      });
    },
  };
}

function eventSelector(event) {
  const kind = typeof event?.kind === "string" ? event.kind : "unknown";
  const toolCallId = event?.data?.tool_call_id;
  if (typeof toolCallId === "string" && toolCallId) {
    return JSON.stringify([kind, "tool_call_id", toolCallId]);
  }
  const role = event?.data?.role;
  if (kind === "message" && typeof role === "string" && role) {
    return JSON.stringify([kind, "role", role]);
  }
  return JSON.stringify([kind]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

function digestParts(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(String(Buffer.byteLength(value)));
    hash.update(":");
    hash.update(value);
  }
  return hash.digest("base64url");
}

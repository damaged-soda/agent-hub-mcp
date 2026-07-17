import * as z from "zod";

export const DISCUSSION_PROTOCOL_VERSION = 1;
export const MATERIAL_ITEM_MAX_BYTES = 128 * 1024;
export const MATERIAL_BUNDLE_MAX_BYTES = 256 * 1024;
export const STRUCTURED_LIMITS = Object.freeze({
  participant_memo: 32 * 1024,
  moderation_plan: 32 * 1024,
  challenge_response: 32 * 1024,
  revision_memo: 32 * 1024,
  decision_record: 64 * 1024,
});

const IdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const RefSchema = z.string().min(1).max(512);
const ShortText = z.string().min(1).max(4096);
const OptionalText = z.string().max(4096);
const TextList = z.array(ShortText).max(64);
const ConfidenceSchema = z
  .object({
    level: z.enum(["low", "medium", "high"]),
    rationale: ShortText,
  })
  .strict();

const InlineMaterialSchema = z
  .object({
    material_id: IdSchema,
    type: z.literal("inline"),
    title: byteLimitedString("material title", 1024),
    content: z.string(),
  })
  .strict();

const FileMaterialSchema = z
  .object({
    material_id: IdSchema,
    type: z.literal("file"),
    title: byteLimitedString("material title", 1024),
    path: z.string().min(1),
  })
  .strict();

export const MaterialSchema = z.discriminatedUnion("type", [
  InlineMaterialSchema,
  FileMaterialSchema,
]);

const MetadataSchema = z.record(z.unknown()).optional().default({});
const HostSchema = z
  .object({
    agent_id: IdSchema,
    metadata: MetadataSchema,
  })
  .strict();
const ParticipantSchema = z
  .object({
    participant_id: IdSchema,
    agent_id: IdSchema,
    role: byteLimitedString("role", 2 * 1024),
    focus: byteLimitedString("focus", 8 * 1024),
    metadata: MetadataSchema,
  })
  .strict();

export const NewDiscussionInputSchema = z
  .object({
    kind: z.literal("new"),
    objective: byteLimitedString("objective", 8 * 1024),
    question: byteLimitedString("question", 16 * 1024),
    cwd: z.string().min(1),
    materials: z.array(MaterialSchema).default([]),
    host: HostSchema,
    participants: z.array(ParticipantSchema).min(2),
    quorum: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quorum > value.participants.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quorum"],
        message: "quorum must not exceed participants.length",
      });
    }
    const ids = new Set();
    for (const [index, participant] of value.participants.entries()) {
      if (ids.has(participant.participant_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participants", index, "participant_id"],
          message: "participant_id must be unique",
        });
      }
      ids.add(participant.participant_id);
      if (participant.participant_id === "host") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participants", index, "participant_id"],
          message: 'participant_id "host" is reserved',
        });
      }
    }
  });

export const FollowUpDiscussionInputSchema = z
  .object({
    kind: z.literal("follow_up"),
    parent_discussion_ref: z.object({ discussion_id: IdSchema }).strict(),
    question: byteLimitedString("question", 16 * 1024),
    materials: z.array(MaterialSchema).default([]),
  })
  .strict();

export const DiscussionDispatchSchema = z.union([
  NewDiscussionInputSchema,
  FollowUpDiscussionInputSchema,
]);

const ClaimSchema = z
  .object({
    claim_id: IdSchema,
    statement: ShortText,
    evidence_refs: z.array(RefSchema).max(32),
  })
  .strict();
const RiskSchema = z
  .object({
    statement: ShortText,
    severity: z.enum(["low", "medium", "high", "critical"]),
    evidence_refs: z.array(RefSchema).max(32),
  })
  .strict();

export const ExternalEvidenceSchema = z
  .object({
    evidence_id: IdSchema,
    kind: z.literal("external"),
    source: z.string().min(1).max(4096),
    retrieved_at: z.string().datetime(),
    claim: ShortText,
    relevance: ShortText,
    status: z.literal("reported").default("reported"),
  })
  .strict();

export const ParticipantMemoSchema = z
  .object({
    schema_version: z.literal(1),
    recommendation: ShortText,
    claims: z.array(ClaimSchema).max(64),
    risks: z.array(RiskSchema).max(64),
    counterexamples: TextList,
    uncertainties: TextList,
    confidence: ConfidenceSchema,
    questions_for_others: TextList,
    external_evidence: z.array(ExternalEvidenceSchema).max(32).optional().default([]),
  })
  .strict();

const AssignmentSchema = z
  .object({
    assignment_id: IdSchema,
    participant_id: IdSchema,
    question: ShortText,
    related_claim_refs: z.array(RefSchema).max(32),
    tests_weakest_shared_assumption: z.boolean().default(false),
  })
  .strict();

export const ModerationPlanSchema = z
  .object({
    schema_version: z.literal(1),
    consensus: TextList,
    disagreements: TextList,
    evidence_gaps: TextList,
    weakest_shared_assumption: ShortText,
    assignments: z.array(AssignmentSchema).min(1),
  })
  .strict();

const EvidenceVerdictSchema = z
  .object({
    evidence_ref: RefSchema,
    status: z.enum(["corroborated", "contested", "unavailable"]),
    rationale: ShortText,
  })
  .strict();

export const ChallengeResponseSchema = z
  .object({
    schema_version: z.literal(1),
    assignment_id: IdSchema,
    tested_claim_refs: z.array(RefSchema).max(64),
    method: ShortText,
    findings: TextList,
    evidence_added: z.array(ExternalEvidenceSchema).max(32),
    evidence_verdicts: z.array(EvidenceVerdictSchema).max(64),
    remaining_uncertainties: TextList,
  })
  .strict();

const ClaimDispositionSchema = z
  .object({
    claim_id: IdSchema,
    disposition: z.enum(["maintained", "modified", "withdrawn"]),
    statement: OptionalText,
    evidence_refs: z.array(RefSchema).max(32),
  })
  .strict();

export const RevisionMemoSchema = z
  .object({
    schema_version: z.literal(1),
    claim_dispositions: z.array(ClaimDispositionSchema).max(64),
    new_claims: z.array(ClaimSchema).max(64),
    responses_to_challenges: TextList,
    recommendation: ShortText,
    disagreements: TextList,
    uncertainties: TextList,
    external_evidence: z.array(ExternalEvidenceSchema).max(32).optional().default([]),
  })
  .strict();

const ProvenancedItemSchema = z
  .object({
    statement: ShortText,
    provenance: z.array(RefSchema).min(1).max(64),
  })
  .strict();
const DecisionEvidenceSchema = ProvenancedItemSchema.extend({
  status: z.enum(["reported", "corroborated", "contested", "unavailable"]),
}).strict();

export const DecisionRecordSchema = z
  .object({
    schema_version: z.literal(1),
    protocol_version: z.literal(DISCUSSION_PROTOCOL_VERSION),
    conclusion_strength: z.enum(["conclusive", "inconclusive"]),
    recommendation: z
      .object({
        summary: ShortText,
        conditions: TextList,
      })
      .strict(),
    consensus: z.array(ProvenancedItemSchema).max(64),
    disagreements: z.array(ProvenancedItemSchema).max(64),
    evidence: z.array(DecisionEvidenceSchema).max(128),
    rejected_options: z.array(ProvenancedItemSchema).max(64),
    risks: z.array(ProvenancedItemSchema).max(64),
    uncertainties: z.array(ProvenancedItemSchema).max(64),
    host_inferences: TextList,
    confidence: ConfidenceSchema,
    next_actions: TextList,
    provenance: z.array(RefSchema).max(256),
  })
  .strict();

export const TURN_SCHEMAS = Object.freeze({
  participant_memo: ParticipantMemoSchema,
  moderation_plan: ModerationPlanSchema,
  challenge_response: ChallengeResponseSchema,
  revision_memo: RevisionMemoSchema,
  decision_record: DecisionRecordSchema,
});

export function parseDiscussionDispatch(input) {
  const parsed = DiscussionDispatchSchema.parse(input);
  const materialIds = new Set();
  for (const material of parsed.materials) {
    if (materialIds.has(material.material_id)) {
      throw codedError("invalid_discussion_request", `Duplicate material_id: ${material.material_id}`);
    }
    materialIds.add(material.material_id);
  }
  return parsed;
}

export function parseStructuredOutput(kind, text) {
  const schema = TURN_SCHEMAS[kind];
  if (!schema) {
    throw codedError("structured_output_invalid", `Unknown structured output kind: ${kind}`);
  }
  const normalized = normalizeStructuredText(text);
  const limit = STRUCTURED_LIMITS[kind];
  if (Buffer.byteLength(normalized, "utf8") > limit) {
    throw codedError("structured_output_invalid", `${kind} exceeds ${limit} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    throw codedError("structured_output_invalid", `Invalid JSON: ${error.message}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw codedError("structured_output_invalid", result.error.issues.map(formatIssue).join("; "));
  }
  return result.data;
}

export function normalizeStructuredText(text) {
  if (typeof text !== "string") {
    throw codedError("structured_output_invalid", "Structured output must be text");
  }
  let normalized = text.replace(/^\uFEFF/, "").trim();
  const fenced = normalized.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) {
    normalized = fenced[1].trim();
  }
  return normalized;
}

export function validateModerationPlan(plan, participantIds) {
  const expected = new Set(participantIds);
  const assigned = new Set(plan.assignments.map((assignment) => assignment.participant_id));
  if (assigned.size !== plan.assignments.length || assigned.size !== expected.size) {
    throw codedError("structured_output_invalid", "assignments must map one-to-one to participants");
  }
  const assignmentIds = new Set(plan.assignments.map((assignment) => assignment.assignment_id));
  if (assignmentIds.size !== plan.assignments.length) {
    throw codedError("structured_output_invalid", "assignment_id must be unique");
  }
  for (const participantId of expected) {
    if (!assigned.has(participantId)) {
      throw codedError("structured_output_invalid", `Missing assignment for ${participantId}`);
    }
  }
  if (!plan.assignments.some((assignment) => assignment.tests_weakest_shared_assumption)) {
    throw codedError(
      "structured_output_invalid",
      "At least one assignment must test the weakest shared assumption",
    );
  }
  return plan;
}

export function validateRevisionMemo(revision, originalMemo) {
  const expected = new Set(originalMemo.claims.map((claim) => claim.claim_id));
  const actual = new Set(revision.claim_dispositions.map((item) => item.claim_id));
  if (actual.size !== revision.claim_dispositions.length || actual.size !== expected.size) {
    throw codedError("structured_output_invalid", "claim_dispositions must cover each original claim once");
  }
  for (const claimId of expected) {
    if (!actual.has(claimId)) {
      throw codedError("structured_output_invalid", `Missing disposition for ${claimId}`);
    }
  }
  for (const item of revision.claim_dispositions) {
    if (item.disposition === "withdrawn" && item.evidence_refs.length > 0) {
      throw codedError("structured_output_invalid", "withdrawn claims cannot add evidence_refs");
    }
  }
  return revision;
}

export function validateDecisionProvenance(decision, allowedRefs) {
  const allowed = new Set(allowedRefs);
  for (const ref of collectProvenanceRefs(decision)) {
    if (!isAllowedRef(ref, allowed)) {
      throw codedError("structured_output_invalid", `Unknown or unavailable provenance: ${ref}`);
    }
  }
  return decision;
}

export function collectProvenanceRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectProvenanceRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") {
    return refs;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "provenance" || key === "evidence_refs") && Array.isArray(child)) {
      refs.push(...child);
    } else {
      collectProvenanceRefs(child, refs);
    }
  }
  return refs;
}

export function aggregateEvidenceStatus(verdicts) {
  const statuses = verdicts.map((item) => item.status);
  if (statuses.includes("contested")) return "contested";
  if (statuses.includes("corroborated")) return "corroborated";
  if (statuses.length > 0 && statuses.every((status) => status === "unavailable")) {
    return "unavailable";
  }
  return "reported";
}

export function resolveDiscussionConfiguration(member, adapter) {
  assertNoPermissionOverrides(member.metadata ?? {});
  const capabilities = adapter?.discussionCapabilities;
  const required = [
    "supported_permissions",
    "preferred_discussion_permission",
    "network_access",
    "max_prompt_bytes",
    "session_resume",
  ];
  for (const key of required) {
    if (capabilities?.[key] === undefined) {
      throw codedError("capability_missing", `${member.agent_id} lacks discussion capability ${key}`);
    }
  }
  const permission = capabilities.preferred_discussion_permission;
  if (!["read-only", "auto"].includes(permission)) {
    throw codedError("unsupported_permission", "Discussion permission must be read-only or auto");
  }
  if (!capabilities.supported_permissions.includes(permission)) {
    throw codedError("unsupported_permission", `${member.agent_id} does not support ${permission}`);
  }
  if (!Number.isInteger(capabilities.max_prompt_bytes) || capabilities.max_prompt_bytes <= 0) {
    throw codedError("capability_invalid", `${member.agent_id} has invalid max_prompt_bytes`);
  }
  const networkAccess = capabilities.network_access[permission];
  if (![true, false, "unknown"].includes(networkAccess)) {
    throw codedError("capability_invalid", `${member.agent_id} has invalid network_access`);
  }
  if (typeof capabilities.session_resume !== "boolean") {
    throw codedError("capability_invalid", `${member.agent_id} has invalid session_resume`);
  }
  return {
    requested_metadata: structuredClone(member.metadata ?? {}),
    effective_metadata: {
      ...(member.metadata ?? {}),
      permission,
    },
    permission,
    network_access: networkAccess,
    max_prompt_bytes: capabilities.max_prompt_bytes,
    session_resume: capabilities.session_resume,
  };
}

export function assertNoPermissionOverrides(metadata) {
  const forbidden = [
    ["permission"],
    ["claude", "permission_mode"],
    ["codex", "sandbox"],
  ];
  for (const path of forbidden) {
    let current = metadata;
    for (const segment of path) current = current?.[segment];
    if (current !== undefined) {
      throw codedError("permission_override_forbidden", `metadata.${path.join(".")} is not allowed`);
    }
  }
}

export function assertPromptSize(prompt, maxBytes) {
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > maxBytes) {
    throw codedError("prompt_too_large", `Rendered prompt is ${bytes} bytes; limit is ${maxBytes}`);
  }
  return bytes;
}

function byteLimitedString(label, maxBytes) {
  return z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, `${label} exceeds ${maxBytes} bytes`);
}

function isAllowedRef(ref, allowed) {
  return allowed.has(ref);
}

function formatIssue(issue) {
  return `${issue.path.join(".") || "value"}: ${issue.message}`;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

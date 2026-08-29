import { describe, expect, it } from "vitest";
import {
  canonicalizeStructuredReferences,
  parseDiscussionDispatch,
  parseStructuredOutput,
  resolveDiscussionConfiguration,
  validateDecisionProvenance,
  validateModerationPlan,
  validateRevisionMemo,
} from "../src/discussion-protocol.js";

describe("discussion protocol", () => {
  it("strictly separates new discussions from follow-ups", () => {
    const parsed = parseDiscussionDispatch({
      kind: "new",
      objective: "decide",
      question: "ship?",
      cwd: "/tmp",
      materials: [],
      host: { agent_id: "codex", metadata: {} },
      participants: [
        { participant_id: "a", agent_id: "codex", role: "r", focus: "f", metadata: {} },
        { participant_id: "b", agent_id: "codex", role: "r", focus: "f", metadata: {} },
      ],
      quorum: 2,
    });
    expect(parsed.kind).toBe("new");
    expect(parsed.budget_profile).toBe("standard");

    expect(parseDiscussionDispatch({
      kind: "new",
      objective: "decide quickly",
      question: "ship?",
      cwd: "/tmp",
      materials: [],
      host: { agent_id: "codex", metadata: {} },
      participants: [
        { participant_id: "a", agent_id: "codex", role: "r", focus: "f", metadata: {} },
        { participant_id: "b", agent_id: "codex", role: "r", focus: "f", metadata: {} },
      ],
      quorum: 2,
      budget_profile: "quick",
    }).budget_profile).toBe("quick");

    expect(() =>
      parseDiscussionDispatch({
        kind: "follow_up",
        parent_discussion_ref: { discussion_id: "parent" },
        question: "what changed?",
        materials: [],
        quorum: 1,
      }),
    ).toThrow();

    expect(() =>
      parseDiscussionDispatch({
        kind: "follow_up",
        parent_discussion_ref: { discussion_id: "parent" },
        question: "what changed?",
        materials: [],
        budget_profile: "research",
      }),
    ).toThrow();

    expect(() =>
      parseDiscussionDispatch({
        kind: "follow_up",
        parent_discussion_ref: { discussion_id: "parent" },
        question: "what changed?",
        materials: [
          { material_id: "same", type: "inline", title: "one", content: "one" },
          { material_id: "same", type: "inline", title: "two", content: "two" },
        ],
      }),
    ).toThrow(/Duplicate material_id/);
  });

  it("only accepts one exact JSON object or a single whole-output fence", () => {
    const memo = {
      schema_version: 1,
      recommendation: "ship",
      claims: [],
      risks: [],
      counterexamples: [],
      uncertainties: [],
      confidence: { level: "medium", rationale: "tested" },
      questions_for_others: [],
      external_evidence: [],
    };
    expect(parseStructuredOutput("participant_memo", `\uFEFF\n\`\`\`json\n${JSON.stringify(memo)}\n\`\`\``)).toEqual(memo);
    expect(() =>
      parseStructuredOutput("participant_memo", `explanation\n${JSON.stringify(memo)}`),
    ).toThrow(/Invalid JSON/);
    expect(() =>
      parseStructuredOutput("participant_memo", JSON.stringify({ ...memo, extra: true })),
    ).toThrow(/Unrecognized key/);
  });

  it("normalizes practical evidence timestamps and unambiguous bare references", () => {
    const memo = parseStructuredOutput(
      "participant_memo",
      JSON.stringify({
        schema_version: 1,
        recommendation: "keep 8700",
        claims: [
          {
            claim_id: "claim-1",
            statement: "the example already uses it",
            evidence_refs: ["brief", "repo-1"],
          },
        ],
        risks: [],
        counterexamples: [],
        uncertainties: [],
        confidence: { level: "high", rationale: "checked" },
        questions_for_others: [],
        external_evidence: [
          {
            evidence_id: "repo-1",
            kind: "external",
            source: "README.md",
            retrieved_at: "2026-07-18T00:00:00.000+08:00",
            claim: "the example uses 8700",
            relevance: "answers the question",
          },
          {
            evidence_id: "repo-2",
            kind: "external",
            source: "src/server.js",
            claim: "the default is 8700",
            relevance: "shows consistency",
          },
        ],
      }),
    );
    const normalized = canonicalizeStructuredReferences(memo, new Set(["material:brief"]));

    expect(normalized.claims[0].evidence_refs).toEqual([
      "material:brief",
      "external:repo-1",
    ]);
    expect(normalized.external_evidence[0].retrieved_at).toBe("2026-07-17T16:00:00.000Z");
    expect(normalized.external_evidence[1].retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("enforces one moderation assignment per effective participant", () => {
    const plan = {
      schema_version: 1,
      consensus: [],
      disagreements: [],
      evidence_gaps: [],
      weakest_shared_assumption: "assumption",
      assignments: [
        {
          assignment_id: "one",
          participant_id: "a",
          question: "test",
          related_claim_refs: [],
          tests_weakest_shared_assumption: true,
        },
      ],
    };
    expect(() => validateModerationPlan(plan, ["a", "b"])).toThrow(/one-to-one/);
  });

  it("requires every original claim to receive one disposition", () => {
    const original = { claims: [{ claim_id: "c1" }, { claim_id: "c2" }] };
    const revision = {
      claim_dispositions: [
        { claim_id: "c1", disposition: "maintained", statement: "same", evidence_refs: [] },
      ],
    };
    expect(() => validateRevisionMemo(revision, original)).toThrow(/cover each original claim/);
  });

  it("does not authorize invented claim fragments from a bare event ref", () => {
    const decision = {
      consensus: [{ statement: "claim", provenance: ["event:7#invented"] }],
    };
    expect(() => validateDecisionProvenance(decision, new Set(["event:7"]))).toThrow(
      /Unknown or unavailable provenance/,
    );
  });

  it("resolves permission from capabilities and rejects caller overrides", () => {
    const adapter = {
      discussionCapabilities: {
        supported_permissions: ["read-only", "auto"],
        preferred_discussion_permission: "read-only",
        network_access: { "read-only": false, auto: true },
        max_prompt_bytes: 1024,
        session_resume: true,
      },
    };
    const resolved = resolveDiscussionConfiguration({ agent_id: "test", metadata: {} }, adapter);
    expect(resolved).toMatchObject({ permission: "read-only", network_access: false });
    expect(() =>
      resolveDiscussionConfiguration(
        { agent_id: "test", metadata: { permission: "auto" } },
        adapter,
      ),
    ).toThrow(/metadata\.permission is not allowed/);
  });
});

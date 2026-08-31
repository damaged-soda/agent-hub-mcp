import { describe, expect, it } from "vitest";
import {
  assertReviewDispatchAllowed,
  createReviewContext,
  normalizeReviewContext,
  reviewContextEnv,
  REVIEW_DEPTH_ENV,
} from "../src/review-context.js";

describe("review context", () => {
  it("creates a normalized first-level context and runtime environment", () => {
    const context = createReviewContext({ requester: "claude-code", reviewer: "codex" });
    expect(context).toEqual({
      version: 1,
      requester: "claude-code",
      reviewer: "codex",
      depth: 1,
    });
    expect(reviewContextEnv(context)).toEqual({ [REVIEW_DEPTH_ENV]: "1" });
  });

  it("rejects malformed contexts", () => {
    expect(() => normalizeReviewContext(null)).toThrow(/review_context/);
    expect(() => normalizeReviewContext({ version: 1, requester: "claude-code", reviewer: "codex", depth: 0 }))
      .toThrow(/depth/);
    expect(() => normalizeReviewContext({ version: 1, requester: "claude_code", reviewer: "codex", depth: 1 }))
      .toThrow(/agent ids/);
  });

  it("blocks nested review dispatch before route discovery", () => {
    expect(() => assertReviewDispatchAllowed({ [REVIEW_DEPTH_ENV]: "1" }))
      .toThrowError(expect.objectContaining({ code: "nested_review_forbidden" }));
    expect(() => assertReviewDispatchAllowed({ [REVIEW_DEPTH_ENV]: "not-a-depth" }))
      .toThrowError(expect.objectContaining({ code: "review_context_invalid" }));
    expect(() => assertReviewDispatchAllowed({})).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { buildReviewPrompt, REVIEW_PROMPT_VERSION } from "../src/review-prompts.js";

describe("review prompts", () => {
  it("identifies the selected reviewer and keeps the original request intact", () => {
    const original = "Review the PR.\nDo not change the workspace.";
    const prompt = buildReviewPrompt({
      requester: "claude-code",
      reviewer: "codex",
      prompt: original,
    });

    expect(prompt).toContain(REVIEW_PROMPT_VERSION);
    expect(prompt).toContain("REQUESTER: claude-code");
    expect(prompt).toContain("REVIEWER: codex");
    expect(prompt).toContain("Perform the review directly in this session.");
    expect(prompt).toContain("Do not invoke `agenthub review dispatch`");
    expect(prompt.endsWith(original)).toBe(true);
  });

  it("rejects empty routing identity or request", () => {
    expect(() => buildReviewPrompt({ requester: "", reviewer: "codex", prompt: "Review" }))
      .toThrow(/requester/);
    expect(() => buildReviewPrompt({ requester: "claude-code", reviewer: "", prompt: "Review" }))
      .toThrow(/reviewer/);
    expect(() => buildReviewPrompt({ requester: "claude-code", reviewer: "codex", prompt: "" }))
      .toThrow(/prompt/);
  });
});

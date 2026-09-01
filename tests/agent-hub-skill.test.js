import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, "skills", "agent-hub");

function readSkillFile(name) {
  return fs.readFileSync(path.join(skillRoot, name), "utf8");
}

describe("Agent Hub Skill bundle", () => {
  it("keeps every routed Markdown reference available", () => {
    const content = readSkillFile("SKILL.md");
    const references = [...content.matchAll(/\]\((references\/[^)]+\.md)\)/g)]
      .map((match) => match[1]);

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(fs.statSync(path.join(skillRoot, reference)).isFile()).toBe(true);
    }
  });

  it("scopes routed review to PR policy or explicit Agent Hub intent", () => {
    const content = readSkillFile("SKILL.md");
    const interfaceContent = readSkillFile("agents/openai.yaml");
    const reviews = readSkillFile("references/reviews.md");
    const runs = readSkillFile("references/runs.md");

    expect(content).toContain("only for the post-PR machine-policy step");
    expect(content).toContain("explicit user request to use Agent Hub's configured review route");
    expect(content).toMatch(/Do not infer this route merely\s+from words such as PR, change, diff, or review/);
    expect(content).not.toContain("PR and change reviews always use `agenthub review dispatch`");
    expect(content).not.toContain("including asking another agent to inspect current changes");

    expect(interfaceContent).toContain("explicitly requested dispatch");
    expect(interfaceContent).toContain("immediately after creating or updating a PR");
    expect(interfaceContent).not.toContain("initiate a review of the current change");

    expect(reviews).toContain("A request to review a diff, change, or existing PR is not by itself a trigger");
    expect(reviews).toMatch(/If the user names a\s+reviewer, use ordinary `agenthub dispatch --agent \.\.\.`/);
    expect(runs).toContain("The selected agent performs the request directly in its session");
    expect(runs).toMatch(/If the review request is addressed to the current process,\s+perform it directly/);
  });

  it("keeps Agent Hub supplementary to native subagent orchestration", () => {
    const content = readSkillFile("SKILL.md");
    const interfaceContent = readSkillFile("agents/openai.yaml");
    const runs = readSkillFile("references/runs.md");
    const projectInstructions = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");

    expect(content).toContain("Use only when the user explicitly requests Agent Hub");
    expect(content).toContain("supplementary cross-provider perspective");
    expect(content).toContain("outside this Skill's scope");
    expect(content).not.toContain("Use when Codex needs to coordinate another coding agent");

    expect(interfaceContent).toContain("Supplementary cross-provider agent dispatch");
    expect(runs).toContain("explicitly requests Agent Hub or selects a named external");
    expect(runs).toContain("unspecified-agent requests are outside this workflow");

    expect(projectInstructions).not.toContain("use the `agenthub` CLI through the versioned `agent-hub` Skill by default");
    expect(projectInstructions).not.toContain("Do not use Codex `multi_agent_v1` sub-agents");
  });
});

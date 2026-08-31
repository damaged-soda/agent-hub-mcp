import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, "skills", "agent-hub");

describe("Agent Hub Skill bundle", () => {
  it("keeps every routed Markdown reference available", () => {
    const content = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    const references = [...content.matchAll(/\]\((references\/[^)]+\.md)\)/g)]
      .map((match) => match[1]);

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(fs.statSync(path.join(skillRoot, reference)).isFile()).toBe(true);
    }
  });
});

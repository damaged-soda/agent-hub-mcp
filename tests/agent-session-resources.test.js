import { describe, expect, it } from "vitest";
import {
  explicitSkillPaths,
  extractResourceAccesses,
  patchTargetPaths,
  shellReadPaths,
} from "../src/agent-session-resources.js";

describe("agent session resource access projection", () => {
  it("extracts structured reads and resolves them against observed cwd", () => {
    expect(
      extractResourceAccesses({
        tool_name: "Read",
        arguments: { file_path: "docs/guide.md" },
        cwd: "/workspace/example",
      }),
    ).toEqual([
      {
        operation: "read",
        path: "/workspace/example/docs/guide.md",
        resource_kind: "file",
        evidence: "structured-path",
        coverage: "exact",
      },
    ]);
  });

  it("extracts escaped patch headers without retaining patch bodies", () => {
    const input = String.raw`const patch = "*** Begin Patch\n*** Update File: src/app.js\n+SECRET_BODY\n*** End Patch";`;
    expect(patchTargetPaths(input)).toEqual(["src/app.js"]);
    expect(extractResourceAccesses({ tool_name: "exec", arguments: input, cwd: "/repo" }))
      .toEqual([
        {
          operation: "write",
          path: "/repo/src/app.js",
          resource_kind: "file",
          evidence: "patch-header",
          coverage: "exact",
        },
      ]);
    const doubleEscaped = String.raw`const patch = "*** Begin Patch\\n*** Add File: src/double.js\\n+SECRET\\n*** End Patch";`;
    expect(patchTargetPaths(doubleEscaped)).toEqual(["src/double.js"]);
  });

  it("extracts explicit file operands from bounded read command adapters", () => {
    const command = "sed -n '1,40p' docs/a.md; cat README.md; head -n 4 src/a.js; " +
      "tail -n 2 src/b.js; wc -l src/c.js; rg -n pattern src/d.js; rg pattern .";
    expect(shellReadPaths(command)).toEqual([
      "docs/a.md",
      "README.md",
      "src/a.js",
      "src/b.js",
      "src/c.js",
      "src/d.js",
    ]);
    const accesses = extractResourceAccesses({
      tool_name: "Bash",
      arguments: { command },
      cwd: "/repo",
    });
    expect(accesses.map((item) => item.path)).toEqual([
      "/repo/docs/a.md",
      "/repo/README.md",
      "/repo/src/a.js",
      "/repo/src/b.js",
      "/repo/src/c.js",
      "/repo/src/d.js",
    ]);
    expect(accesses.every((item) => item.evidence === "shell-explicit-operand")).toBe(true);
  });

  it("unwraps bounded shell -c launchers and recognizes nl reads", () => {
    const command = "/bin/zsh -lc \"nl -ba bin/cockpit-agent | sed -n '1p'; " +
      "rg -n pattern docs/agent-data-pipeline.md\"";
    expect(shellReadPaths(command, "/workspace/cockpit")).toEqual([
      "/workspace/cockpit/bin/cockpit-agent",
      "/workspace/cockpit/docs/agent-data-pipeline.md",
    ]);
    expect(shellReadPaths(
      "/usr/bin/env bash -lc \"zsh -c 'cat README.md'\"",
      "/workspace/cockpit",
    )).toEqual(["/workspace/cockpit/README.md"]);
    expect(shellReadPaths("zsh -l scripts/report.sh", "/workspace/cockpit")).toEqual([]);
    const observed = "/bin/zsh -lc \"sed -n '780,850p' deploy/assets/charter.js && " +
      "rg -n -C 3 hotspot deploy/glance-agent.yml deploy/glance-charter.yml deploy/glance.yml\"";
    expect(shellReadPaths(observed, "/workspace/cockpit")).toEqual([
      "/workspace/cockpit/deploy/assets/charter.js",
      "/workspace/cockpit/deploy/glance-agent.yml",
      "/workspace/cockpit/deploy/glance-charter.yml",
      "/workspace/cockpit/deploy/glance.yml",
    ]);
    expect(shellReadPaths(
      "/bin/zsh -lc \"rg --files | rg -i charter\"",
      "/workspace/cockpit",
    )).toEqual([]);
  });

  it("finds nested programmatic commands and explicit SKILL.md reads", () => {
    const input = String.raw`const r = await tools.exec_command({"cmd":"sed -n '1,220p' /repo/.agents/skills/demo/SKILL.md","workdir":"/repo"});`;
    const accesses = extractResourceAccesses({ tool_name: "exec", arguments: input, cwd: "/repo" });
    expect(explicitSkillPaths(input)).toEqual(["/repo/.agents/skills/demo/SKILL.md"]);
    expect(accesses).toContainEqual({
      operation: "read",
      path: "/repo/.agents/skills/demo/SKILL.md",
      resource_kind: "skill",
      evidence: "skill-path-literal",
      coverage: "high-confidence",
    });
  });

  it("does not infer variable, glob, directory-wide search, or URL operands", () => {
    expect(shellReadPaths("cat $FILE; cat '*.md'; rg pattern .; cat https://example/a.md"))
      .toEqual([]);
    expect(shellReadPaths("cat input.md > output.md; cat < stdin.md"))
      .toEqual(["input.md", "stdin.md"]);
    expect(shellReadPaths("cat ~/.ssh/config; rg pattern src/; rg pattern src/lib"))
      .toEqual([]);
    expect(explicitSkillPaths("path LIKE '%/SKILL.md'"))
      .toEqual([]);
  });

  it("drops fd, heredoc, and multiline command noise while preserving explicit reads", () => {
    const command = `cat > /tmp/deploy.env <<'EOF'
DEPLOY_TOKEN=ghp_secret_value
cat confidential.md
EOF
cat README.md 2>/dev/null
head -3 docs/b.md 2>&1
cat <<< hello
sed -i '' 's/a/b/' config.md
rg -e pattern src/file.js
rg pattern src/
rm -rf build
cd nested
cat child.md`;
    expect(shellReadPaths(command, "/repo")).toEqual([
      "/repo/README.md",
      "/repo/docs/b.md",
      "/repo/config.md",
      "/repo/src/file.js",
      "/repo/nested/child.md",
    ]);
  });

  it("prefers the explicit tool workdir over session cwd", () => {
    expect(extractResourceAccesses({
      tool_name: "exec_command",
      arguments: { cmd: "cat local.md", workdir: "/work/other" },
      cwd: "/work/session",
    }).map((item) => item.path)).toEqual(["/work/other/local.md"]);
  });
});

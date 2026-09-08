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
    expect(shellReadPaths(
      "nl -b a -n rz -s : --number-width 4 src/app.js",
      "/workspace/cockpit",
    )).toEqual(["/workspace/cockpit/src/app.js"]);
    expect(shellReadPaths(
      "nl --body-numbering a --number-format rz --number-separator : src/app.js",
      "/workspace/cockpit",
    )).toEqual(["/workspace/cockpit/src/app.js"]);
    expect(shellReadPaths(
      "bash -- -c 'cat README.md'; zsh --command 'cat docs/guide.md'",
      "/workspace/cockpit",
    )).toEqual([]);
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

  it("keeps identical commands in distinct workdirs and inherits missing overrides", () => {
    const input = ["/a", "/b", "/a", null].map((workdir) =>
      `tools.exec_command(${JSON.stringify({ cmd: "cat file.md", workdir })})`).join(";");
    expect(extractResourceAccesses({ tool_name: "exec", cwd: "/session", arguments: input })
      .map((item) => item.path)).toEqual(["/a/file.md", "/b/file.md", "/session/file.md"]);
  });

  it.each([
    ['', ["/absolute.md", "/session/file.md"]],
    ['workdir: `/other`', ["/absolute.md", "/other/file.md"]],
    ['workdir: directory', ["/absolute.md"]],
    ['workdir: "relative"', ["/absolute.md"]],
    ['workdir: "/wrong", workdir: directory', ["/absolute.md"]],
  ])("resolves literal directories and leaves unknown overrides unresolved: %s", (directory, paths) => {
    const input = `tools.exec_command({cmd: "cat file.md /absolute.md", ${directory}})`;
    expect(extractResourceAccesses({ tool_name: "exec", cwd: "/session", arguments: input })
      .map((item) => item.path)).toEqual(paths);
  });

  it("uses the call directory for Skills and tracks literal and dynamic shell cd", () => {
    const cmd = "cat skills/demo/SKILL.md; cd $DIR && cat unknown.md; cd /known && cat file.md";
    for (const input of [{ cmd, workdir: "/other" }, `tools.exec_command(${JSON.stringify({ cmd, workdir: "/other" })})`]) {
      expect(extractResourceAccesses({ tool_name: "exec", cwd: "/session", arguments: input })
        .map((item) => item.path)).toEqual(["/known/file.md", "/other/skills/demo/SKILL.md"]);
    }
  });

  it.each([
    'tools.exec_command({cmd: "cat false.md", ...options})',
    'tools.exec_command({cmd: "cat false.md", [key]: directory})',
    'tools.exec_command({cmd: "cat false.md", get workdir() { return "/other"; }})',
    'tools.exec_command({cmd: "cat false.md" + suffix})',
    'tools.exec_command({cmd: "cat false.md",',
    '// tools.exec_command({cmd: "cat false.md"})',
    'const example = \'tools.exec_command({cmd: "cat false.md"})\';',
  ])("skips ambiguous parameters and non-call text: %s", (input) => {
    expect(extractResourceAccesses({ tool_name: "exec", arguments: input, cwd: "/session" })).toEqual([]);
  });

  it("skips oversized wrapper source without parsing a truncated command", () => {
    expect(extractResourceAccesses({ tool_name: "exec", cwd: "/session",
      arguments: 'tools.exec_command({cmd: "cat false.md"});' + ' '.repeat(256 * 1024),
    })).toEqual([]);
  });

  it("projects a Skill tool argument as a bare skill identifier, never a cwd path", () => {
    const skillRow = (name) => ({
      operation: "read", path: name, resource_kind: "skill",
      evidence: "skill-tool-argument", coverage: "exact",
    });
    expect(extractResourceAccesses({
      tool_name: "Skill",
      arguments: { skill: "agent-hub", args: "Private free text" },
      cwd: "/workspace/example",
    })).toEqual([skillRow("agent-hub")]);
    expect(extractResourceAccesses({
      tool_name: "Skill", arguments: { skill: "feature-dev:feature-dev" },
    })).toEqual([skillRow("feature-dev:feature-dev")]);
    expect(extractResourceAccesses({
      tool_name: "Skill", arguments: '{"skill":"agent-hub"}',
    })).toEqual([skillRow("agent-hub")]);
    // Skill input is never scanned by the generic adapters: neither object nor string-JSON
    // free text can smuggle a path row into metadata.
    expect(extractResourceAccesses({
      tool_name: "Skill", arguments: { skill: "agent-hub", cmd: "cat agent-hub" },
    })).toEqual([skillRow("agent-hub")]);
    expect(extractResourceAccesses({
      tool_name: "Skill",
      arguments: JSON.stringify({ skill: "agent-hub", args: "cmd: 'cat /Private/SKILL.md'" }),
      cwd: "/workspace/example",
    })).toEqual([skillRow("agent-hub")]);
    expect(extractResourceAccesses({
      tool_name: "Skill",
      arguments: JSON.stringify({ skill: "docs/agent-hub", args: "cat /Private/SKILL.md" }),
    })).toEqual([]);
  });

  it("rejects Skill names that are missing, non-string, path-like, or malformed", () => {
    for (const skill of [undefined, "", "   ", 42, ["agent-hub"], { name: "x" },
      "docs/agent-hub", "..", ".hidden", "-flag", "a b", "a\\b", "x".repeat(129)]) {
      expect(extractResourceAccesses({ tool_name: "Skill", arguments: { skill } })).toEqual([]);
    }
    expect(extractResourceAccesses({ tool_name: "skill", arguments: { skill: "agent-hub" } }))
      .toEqual([]);
    expect(extractResourceAccesses({ tool_name: "Read", arguments: { skill: "agent-hub" } }))
      .toEqual([]);
  });
});

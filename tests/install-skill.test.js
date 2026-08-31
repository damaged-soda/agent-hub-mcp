import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const INSTALLER = path.resolve("scripts/install-skill.js");

describe("bundled Skill installer", () => {
  let root;
  let codexHome;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-install-skill-"));
    codexHome = path.join(root, "codex-home");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("installs every bundled Skill without touching unrelated Skills", async () => {
    const unrelated = path.join(codexHome, "skills", "unrelated", "SKILL.md");
    await fsp.mkdir(path.dirname(unrelated), { recursive: true });
    await fsp.writeFile(unrelated, "keep me\n");

    const { stdout } = await execFileAsync(process.execPath, [INSTALLER], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    const installed = stdout.trim().split("\n").map((value) => path.basename(value));
    expect(installed).toEqual(["agent-hub", "eval-driven-refactor"]);
    await expect(fsp.readFile(path.join(codexHome, "skills", "agent-hub", "SKILL.md"), "utf8"))
      .resolves.toContain("name: agent-hub");
    await expect(fsp.readFile(path.join(codexHome, "skills", "eval-driven-refactor", "SKILL.md"), "utf8"))
      .resolves.toContain("name: eval-driven-refactor");
    await expect(fsp.readFile(unrelated, "utf8")).resolves.toBe("keep me\n");
  });

  it("replaces stale content in a bundled Skill directory", async () => {
    const stale = path.join(codexHome, "skills", "eval-driven-refactor", "stale.txt");
    await fsp.mkdir(path.dirname(stale), { recursive: true });
    await fsp.writeFile(stale, "stale\n");

    await execFileAsync(process.execPath, [INSTALLER], {
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    await expect(fsp.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

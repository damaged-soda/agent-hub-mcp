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

  it("validates every bundled Skill before replacing any installed Skill", async () => {
    const fixture = path.join(root, "fixture");
    const fixtureInstaller = path.join(fixture, "scripts", "install-skill.js");
    const installedSkill = path.join(codexHome, "skills", "agent-hub", "SKILL.md");
    await fsp.mkdir(path.dirname(fixtureInstaller), { recursive: true });
    await fsp.copyFile(INSTALLER, fixtureInstaller);
    await fsp.mkdir(path.join(fixture, "skills", "agent-hub"), { recursive: true });
    await fsp.writeFile(path.join(fixture, "skills", "agent-hub", "SKILL.md"), "new\n");
    await fsp.mkdir(path.join(fixture, "skills", "zzz-broken"), { recursive: true });
    await fsp.mkdir(path.dirname(installedSkill), { recursive: true });
    await fsp.writeFile(installedSkill, "existing\n");

    await expect(execFileAsync(process.execPath, [fixtureInstaller], {
      env: { ...process.env, CODEX_HOME: codexHome },
    })).rejects.toMatchObject({
      stderr: "Failed to install bundled skills: Bundled skill zzz-broken is missing SKILL.md\n",
    });
    await expect(fsp.readFile(installedSkill, "utf8")).resolves.toBe("existing\n");
  });
});

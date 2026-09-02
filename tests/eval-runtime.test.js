import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PYTHON_RUNTIME_PROBE_ARGS,
  createRuntimeCommandBin,
  detectPythonRuntime,
} from "../src/eval-runtime.js";

const execFileAsync = promisify(execFile);

describe("Eval Python runtime", () => {
  let root;
  let readonlyDirs;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-eval-runtime-"));
    readonlyDirs = [];
  });

  afterEach(async () => {
    for (const directory of readonlyDirs) {
      await fsp.chmod(directory, 0o700).catch(() => undefined);
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("uses an isolated probe that cannot load site configuration", () => {
    expect(PYTHON_RUNTIME_PROBE_ARGS.slice(0, 3)).toEqual(["-I", "-S", "-c"]);
    expect(Object.isFrozen(PYTHON_RUNTIME_PROBE_ARGS)).toBe(true);
  });

  it("does not expose provider credentials to runtime probes", async () => {
    const prefix = path.join(root, "credential-safe-python");
    const executable = path.join(prefix, "bin", "python3");
    const identity = JSON.stringify([executable, prefix, prefix]);
    await writeShellProgram(
      executable,
      '[ -z "${OPENAI_API_KEY+x}" ] || exit 9\n' +
        `printf '%s\\n' ${shellQuote(identity)}`,
    );

    const runtime = await detectPythonRuntime(
      {
        PATH: path.dirname(executable),
        HOME: path.join(root, "home"),
        OPENAI_API_KEY: "must-not-reach-probe",
      },
      { fallback_candidates: [] },
    );

    expect(runtime?.executable).toBe(await fsp.realpath(executable));
  });

  it("preserves reported lexical and real executable roots for a namespace symlink", async () => {
    const namespaceBin = path.join(root, "ns", "base", "python", "bin");
    const prefix = path.join(
      root,
      "opt",
      "homebrew",
      "Cellar",
      "python@3.12",
      "3.12.13",
      "Frameworks",
      "Python.framework",
      "Versions",
      "3.12",
    );
    const realExecutable = path.join(prefix, "bin", "python3.12");
    const lexicalExecutable = path.join(namespaceBin, "python3");
    await fsp.mkdir(namespaceBin, { recursive: true });
    await writeProbe(realExecutable, [lexicalExecutable, prefix, prefix]);
    await fsp.symlink(realExecutable, lexicalExecutable);

    const runtime = await detectPythonRuntime(
      { PATH: namespaceBin, HOME: path.join(root, "home") },
      { fallback_candidates: [] },
    );

    const expectedReadPaths = Array.from(new Set([
      namespaceBin,
      await fsp.realpath(namespaceBin),
      await fsp.realpath(path.dirname(realExecutable)),
      prefix,
      await fsp.realpath(prefix),
    ])).sort();
    expect(runtime).toEqual({
      executable: await fsp.realpath(realExecutable),
      read_paths: expectedReadPaths,
      identity: {
        executable: lexicalExecutable,
        prefix,
        base_prefix: prefix,
      },
    });
  }, 15000);

  it("skips a broken xcrun candidate and bypasses a reporting shim", async () => {
    const brokenBin = path.join(root, "broken", "bin");
    const shimBin = path.join(root, "pyenv", "shims");
    const runtimePrefix = path.join(root, "runtime", "python");
    const realExecutable = path.join(runtimePrefix, "bin", "python3.12");
    await writeProgram(
      path.join(brokenBin, "python3"),
      "process.stderr.write('xcrun: invalid active developer path\\n'); process.exit(72);",
    );
    await writeProbe(path.join(shimBin, "python3"), [realExecutable, runtimePrefix, runtimePrefix]);
    await writeProbe(realExecutable, [realExecutable, runtimePrefix, runtimePrefix]);

    const runtime = await detectPythonRuntime(
      {
        PATH: [brokenBin, shimBin].join(path.delimiter),
        HOME: path.join(root, "home"),
      },
      { fallback_candidates: [] },
    );

    expect(runtime.executable).toBe(await fsp.realpath(realExecutable));
    expect(runtime.read_paths).toEqual(Array.from(new Set([
      path.dirname(realExecutable),
      await fsp.realpath(path.dirname(realExecutable)),
      runtimePrefix,
      await fsp.realpath(runtimePrefix),
    ])).sort());
    expect(runtime.read_paths).not.toContain(brokenBin);
    expect(runtime.read_paths).not.toContain(shimBin);
  }, 15000);

  it("ignores malformed and nonzero candidates before selecting a valid runtime", async () => {
    const nonzeroBin = path.join(root, "nonzero");
    const malformedBin = path.join(root, "malformed");
    const goodBin = path.join(root, "good", "bin");
    const prefix = path.join(root, "good");
    const goodExecutable = path.join(goodBin, "python3");
    await writeShellProgram(path.join(nonzeroBin, "python3"), "exit 9");
    await writeShellProgram(
      path.join(malformedBin, "python3"),
      "printf '%s\\n' not-json",
    );
    await writeProbe(goodExecutable, [goodExecutable, prefix, prefix]);

    const runtime = await detectPythonRuntime(
      {
        PATH: [nonzeroBin, malformedBin, goodBin].join(path.delimiter),
        HOME: path.join(root, "home"),
      },
      { fallback_candidates: [] },
    );

    expect(runtime.executable).toBe(await fsp.realpath(goodExecutable));
  }, 15000);

  it("ignores a timed-out candidate", async () => {
    const timeoutBin = path.join(root, "timeout");
    await writeShellProgram(path.join(timeoutBin, "python3"), "exec /bin/sleep 10");

    await expect(detectPythonRuntime(
      { PATH: timeoutBin, HOME: path.join(root, "home") },
      { timeout_ms: 500, fallback_candidates: [] },
    )).resolves.toBeNull();
  });

  it("returns null instead of treating malformed output as a runtime", async () => {
    const bin = path.join(root, "invalid");
    await writeProgram(
      path.join(bin, "python3"),
      "process.stdout.write(JSON.stringify(['relative-python', '/', '/']));",
    );
    await expect(detectPythonRuntime(
      { PATH: bin, HOME: path.join(root, "home") },
      { fallback_candidates: [] },
    )).resolves.toBeNull();
  });

  it.each(["filesystem root", "HOME"])('rejects a read capability covering %s', async (kind) => {
    const home = path.join(root, "home");
    const bin = path.join(root, kind === "HOME" ? "home-python" : "root-python");
    const executable = path.join(bin, "python3");
    await fsp.mkdir(home, { recursive: true });
    const prefix = kind === "HOME" ? home : path.parse(root).root;
    await writeProbe(executable, [executable, prefix, prefix]);

    await expect(detectPythonRuntime(
      { PATH: bin, HOME: home },
      { fallback_candidates: [] },
    )).resolves.toBeNull();
  });

  it("includes an enclosing CommandLineTools root without widening above it", async () => {
    const commandLineTools = path.join(root, "Library", "Developer", "CommandLineTools");
    const prefix = path.join(
      commandLineTools,
      "Library",
      "Frameworks",
      "Python3.framework",
      "Versions",
      "3.9",
    );
    const executable = path.join(prefix, "bin", "python3");
    await writeProbe(executable, [executable, prefix, prefix]);

    const runtime = await detectPythonRuntime(
      { PATH: path.dirname(executable), HOME: path.join(root, "home") },
      { fallback_candidates: [] },
    );

    expect(runtime.read_paths).toContain(commandLineTools);
    expect(runtime.read_paths).not.toContain(path.dirname(commandLineTools));
  });

  it("does not execute a repository-local virtualenv candidate", async () => {
    // The root deliberately starts with two dots: containment checks must not
    // confuse an in-root name such as "..repo" with a parent traversal.
    const workspace = path.join(root, "..repo");
    const venvBin = path.join(workspace, ".venv", "bin");
    const marker = path.join(root, "repo-python-executed");
    const venvExecutable = path.join(venvBin, "python3");
    const systemPrefix = path.join(root, "system-python");
    const systemExecutable = path.join(systemPrefix, "bin", "python3");
    await writeProgram(
      venvExecutable,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.exit(9);`,
    );
    await writeProbe(systemExecutable, [systemExecutable, systemPrefix, systemPrefix]);

    const runtime = await detectPythonRuntime(
      { PATH: venvBin, HOME: path.join(root, "home") },
      {
        fallback_candidates: [systemExecutable],
        forbidden_roots: [workspace],
      },
    );

    expect(runtime.executable).toBe(await fsp.realpath(systemExecutable));
    await expect(fsp.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.read_paths.some((item) => pathIsInside(item, workspace))).toBe(false);
  });

  it("rejects a canonical probe that forges unrelated prefix roots", async () => {
    const bin = path.join(root, "forged", "bin");
    const executable = path.join(bin, "python3");
    const unrelated = path.join(root, "sensitive");
    await fsp.mkdir(unrelated, { recursive: true });
    await writeProbe(executable, [executable, unrelated, unrelated]);

    await expect(detectPythonRuntime(
      { PATH: bin, HOME: path.join(root, "home") },
      { fallback_candidates: [] },
    )).resolves.toBeNull();
  });

  it("creates canonical read-only symlinks that preserve every argument", async () => {
    const parent = path.join(root, "private parent");
    const executable = path.join(root, "runtime with quote's", "python3");
    const reportedExecutable = path.join(root, "namespace", "bin", "python3");
    await fsp.mkdir(parent);
    await writeProgram(
      executable,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    );
    await fsp.mkdir(path.dirname(reportedExecutable), { recursive: true });
    await fsp.symlink(executable, reportedExecutable);

    const commandBin = await createRuntimeCommandBin(parent, { python3: reportedExecutable });
    readonlyDirs.push(commandBin);
    const wrapperPath = path.join(commandBin, "python3");
    const wrapperStat = await fsp.lstat(wrapperPath);
    expect(wrapperStat.isSymbolicLink()).toBe(true);
    expect(await fsp.readlink(wrapperPath)).toBe(await fsp.realpath(executable));
    expect((await fsp.stat(commandBin)).mode & 0o777).toBe(0o555);

    const { stdout } = await execFileAsync(wrapperPath, ["-m", "unit test", "a'b", ""]);
    expect(JSON.parse(stdout)).toEqual(["-m", "unit test", "a'b", ""]);
  });

  it.each(["", ".python3", "../python3", "python/3", "python 3", "python+3"])(
    "rejects invalid command name %j before creating runtime-bin",
    async (name) => {
      const parent = path.join(root, `invalid-${Buffer.from(name).toString("hex") || "empty"}`);
      const executable = path.join(root, "valid", "python3");
      await fsp.mkdir(parent);
      await writeProgram(executable, "process.exit(0);");

      await expect(createRuntimeCommandBin(parent, { [name]: executable }))
        .rejects.toThrow(/Invalid runtime command name/);
      await expect(fsp.access(path.join(parent, "runtime-bin")))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects relative, missing, and non-executable command targets", async () => {
    const relativeParent = path.join(root, "relative");
    const missingParent = path.join(root, "missing");
    const blockedParent = path.join(root, "blocked");
    await Promise.all([
      fsp.mkdir(relativeParent),
      fsp.mkdir(missingParent),
      fsp.mkdir(blockedParent),
    ]);
    const blocked = path.join(root, "blocked-python");
    await fsp.writeFile(blocked, "#!/bin/sh\nexit 0\n", { mode: 0o600 });

    await expect(createRuntimeCommandBin(relativeParent, { python3: "python3" }))
      .rejects.toThrow(/absolute executable/);
    await expect(createRuntimeCommandBin(missingParent, {
      python3: path.join(root, "does-not-exist"),
    })).rejects.toThrow(/unavailable/);
    await expect(createRuntimeCommandBin(blockedParent, { python3: blocked }))
      .rejects.toThrow(/unavailable/);
  });
});

async function writeProbe(target, identity) {
  await writeShellProgram(
    target,
    `[ "$#" -eq ${PYTHON_RUNTIME_PROBE_ARGS.length} ] && ` +
      `[ "$1" = ${shellQuote(PYTHON_RUNTIME_PROBE_ARGS[0])} ] && ` +
      `[ "$2" = ${shellQuote(PYTHON_RUNTIME_PROBE_ARGS[1])} ] && ` +
      `[ "$3" = ${shellQuote(PYTHON_RUNTIME_PROBE_ARGS[2])} ] && ` +
      `[ "$4" = ${shellQuote(PYTHON_RUNTIME_PROBE_ARGS[3])} ] || exit 97\n` +
      `printf '%s\\n' ${shellQuote(JSON.stringify(identity))}`,
  );
}

async function writeProgram(target, body) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  await fsp.chmod(target, 0o755);
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function writeShellProgram(target, body) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await fsp.chmod(target, 0o755);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

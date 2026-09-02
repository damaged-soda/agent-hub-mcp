import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("src/cli.js");

describe("agenthub eval CLI", () => {
  let root;
  let workspace;
  let runDir;
  let evalDir;
  let fakeBin;
  let env;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-eval-cli-"));
    workspace = path.join(root, "workspace");
    runDir = path.join(root, "runs");
    evalDir = path.join(root, "evals");
    fakeBin = path.join(root, "bin");
    const fakeCodeHome = path.join(root, "codex-home");
    const defaultZdot = path.join(root, "default-zdot");
    await fsp.mkdir(path.join(workspace, ".agenthub"), { recursive: true });
    await fsp.mkdir(path.join(workspace, "src"), { recursive: true });
    await fsp.mkdir(fakeBin, { recursive: true });
    await fsp.mkdir(fakeCodeHome, { recursive: true });
    await fsp.mkdir(defaultZdot, { recursive: true });
    await fsp.writeFile(path.join(defaultZdot, ".zshenv"), "");
    await fsp.writeFile(
      path.join(workspace, "src", "app.js"),
      "export function locateTarget() { return true; }\n",
    );
    await fsp.writeFile(
      path.join(workspace, ".agenthub", "evals.json"),
      `${JSON.stringify({
        schema_version: 1,
        suite_id: "code-navigation",
        cases: [{
          id: "locate-target",
          prompt: "Find the production definition responsible for the target behavior.",
          answer_schema: "source-location/v1",
        }],
      }, null, 2)}\n`,
    );
    await git(workspace, "init");
    await git(workspace, "config", "user.email", "test@example.invalid");
    await git(workspace, "config", "user.name", "Agent Hub Test");
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "fixture");
    await writeFakeCodex(path.join(fakeBin, "codex"));
    const helper = path.join(root, "eval-helper.mjs");
    await fsp.writeFile(
      helper,
      `import { main } from ${JSON.stringify(pathToFileURL(CLI_PATH).href)};
const answers = JSON.parse(process.env.AGENT_HUB_TEST_ANSWERS);
let index = 0;
const io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  readStdin: async () => "",
  readLine: async (prompt) => {
    process.stderr.write(prompt);
    if (index >= answers.length) throw new Error("test answer queue exhausted");
    return String(answers[index++]);
  },
  closeInput: () => undefined,
};
process.exitCode = await main(process.argv.slice(2), io);
`,
    );
    env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CODEX_HOME: fakeCodeHome,
      ZDOTDIR: defaultZdot,
      AGENT_HUB_FORWARD_ENV: "ZDOTDIR",
      AGENT_HUB_RUN_DIR: runDir,
      AGENT_HUB_EVAL_DIR: evalDir,
      AGENT_HUB_TEST_HELPER: helper,
    };
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("collects answers once, runs an isolated case, and persists only digests", async () => {
    const evaluatorSuite = path.join(root, "evaluator-suite.json");
    await fsp.copyFile(path.join(workspace, ".agenthub", "evals.json"), evaluatorSuite);
    const result = await invokeEval([
      "src/app.js",
      "locateTarget",
      "1",
    ], "codex", evaluatorSuite);

    expect(result.status).toBe("completed");
    expect(result.suite.relative_path).toBe("../evaluator-suite.json");
    expect(result.agent).toMatchObject({
      agent_id: "codex",
      version: "codex-cli 0.151.0",
      model: "gpt-test",
      effort: "medium",
    });
    expect(result.isolation).toMatchObject({
      policy: "workspace-readonly/v1",
      git_history: false,
      tool_network: false,
      memory: "off",
      session_persistence: false,
    });
    expect(result.summary).toMatchObject({ pass: 1, fail: 0, error: 0 });
    expect(result.cases[0]).toMatchObject({
      case_id: "locate-target",
      status: "pass",
      reason: "exact_match",
      metrics: {
        telemetry_status: "available",
        turns: 1,
        tool_calls: 1,
        observed_file_reads: 1,
        observed_unique_files: 1,
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
        canonical_usage: {
          input_total_tokens: 100,
          input_new_tokens: 80,
          input_cache_read_tokens: 20,
          output_total_tokens: 10,
        },
      },
    });

    const evalArtifact = JSON.parse(await fsp.readFile(result.artifact.path, "utf8"));
    expect((await fsp.stat(result.artifact.path)).mode & 0o777).toBe(0o600);
    expect(evalArtifact.artifact).toBeUndefined();
    expect(evalArtifact.cases[0].answer_digest).toMatch(/^[0-9a-f]{64}$/);
    const command = JSON.parse(await fsp.readFile(
      path.join(runDir, result.cases[0].agent_run_ref.run_id, "command.json"),
      "utf8",
    ));
    expect(command.argv).toContain("gpt-test");
    expect(command.argv).toContain('model_reasoning_effort="medium"');
    expect(JSON.stringify(command.argv)).not.toContain(evaluatorSuite);
    expect(command.argv).toContain("--ephemeral");
    expect(command.argv).not.toContain("--sandbox");
    expect(command.argv).toContain('default_permissions="agenthub-eval"');
    expect(command.argv.find((item) => item.startsWith("permissions.agenthub-eval=")))
      .toContain('":workspace_roots"');
  }, 20000);

  it("does not persist a wrong human standard answer in run or eval artifacts", async () => {
    const secretSymbol = "humanOnlyOracleSymbol";
    await fsp.writeFile(
      path.join(workspace, "src", "app.js"),
      `export function ${secretSymbol}() { return true; }\n`,
    );
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "move oracle");

    const result = await invokeEval(["src/app.js", secretSymbol, "1"]);
    expect(result.cases[0]).toMatchObject({ status: "fail", reason: "incorrect" });
    expect(await allText(runDir)).not.toContain(secretSymbol);
    expect(await allText(evalDir)).not.toContain(secretSymbol);
  }, 20000);

  it("runs a patch case in a disposable worktree and grades it with a hidden verifier", async () => {
    await fsp.writeFile(
      path.join(workspace, ".agenthub", "evals.json"),
      `${JSON.stringify({
        schema_version: 2,
        suite_id: "patch-eval",
        cases: [{
          id: "change-target",
          prompt: "Change locateTarget so it returns the string changed.",
          answer_schema: "workspace-patch/v1",
        }],
      }, null, 2)}\n`,
    );
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "patch suite");
    const hookMarker = path.join(root, "post-checkout-called");
    const gitDir = (await git(workspace, "rev-parse", "--git-dir")).stdout.trim();
    const hook = path.join(workspace, gitDir, "hooks", "post-checkout");
    await fsp.writeFile(
      hook,
      `#!/bin/sh\nprintf called > ${JSON.stringify(hookMarker)}\n`,
      { mode: 0o700 },
    );
    await fsp.chmod(hook, 0o700);
    const verifierDir = path.join(root, "verifiers");
    const verifier = path.join(verifierDir, "hidden-patch-verifier");
    await fsp.mkdir(verifierDir);
    await fsp.writeFile(
      verifier,
      `#!/bin/sh\n# human-only-verifier-secret\n` +
        `if [ "$0" = ${JSON.stringify(verifier)} ]; then exit 9; fi\n` +
        "grep -q '\"changed\"' src/app.js\n",
      { mode: 0o700 },
    );
    await fsp.chmod(verifier, 0o700);

    const original = await fsp.readFile(path.join(workspace, "src", "app.js"), "utf8");
    const result = await invokeEval([verifier]);

    expect(result).toMatchObject({
      schema_version: 2,
      grader_version: "workspace-patch/v1",
      isolation: {
        policy: "workspace-write/v1",
        git_history: false,
        memory: "off",
      },
      summary: { pass: 1, fail: 0, error: 0 },
    });
    expect(result.cases[0]).toMatchObject({
      status: "pass",
      reason: "verifier_passed",
      metrics: {
        patch: {
          status: "available",
          changed_files: 1,
          modified_files: 1,
        },
        verifier: { status: "passed", exit_code: 0 },
      },
    });
    expect(result.cases[0].metrics.patch.patch_digest).toMatch(/^[0-9a-f]{64}$/);
    const rawVerifierDigest = crypto.createHash("sha256")
      .update(await fsp.readFile(verifier))
      .digest("hex");
    expect(result.cases[0].answer_digest).not.toBe(rawVerifierDigest);
    expect(await fsp.readFile(path.join(workspace, "src", "app.js"), "utf8")).toBe(original);
    await expect(fsp.access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await allText(runDir)).not.toContain(verifier);
    expect(await allText(evalDir)).not.toContain(verifier);
    expect(await allText(runDir)).not.toContain("human-only-verifier-secret");
    expect(await allText(evalDir)).not.toContain("human-only-verifier-secret");
    const command = JSON.parse(await fsp.readFile(
      path.join(runDir, result.cases[0].agent_run_ref.run_id, "command.json"),
      "utf8",
    ));
    expect(command.argv.find((item) => item.startsWith("permissions.agenthub-eval=")))
      .toContain('":workspace_roots" = { "." = "write"');
    expect(await fsp.readdir(path.join(evalDir, ".verifier-scratch"))).toEqual([]);
    expect((await fsp.readdir(root)).filter((name) => name.startsWith(".agenthub-eval-")))
      .toEqual([]);
  }, 20000);

  it("delivers the detected Python command after child namespace rebinding", async () => {
    const selectedBin = path.join(root, "selected-python", "bin");
    const selectedPrefix = path.join(root, "selected-python");
    const selectedExecutable = path.join(selectedPrefix, "libexec", "python3.12");
    const selectedCommand = path.join(selectedBin, "python3");
    const brokenBin = path.join(root, "broken-system-bin");
    const reboundCodexBin = path.join(root, "rebound-codex-bin");
    const callerNodeBin = path.join(root, "caller-node-bin");
    const reboundNodeBin = path.join(root, "rebound-node-bin");
    const reboundCodeHome = path.join(root, "rebound-codex-home");
    const zdot = path.join(root, "zdot");
    const projectBin = path.join(workspace, "bin");
    const ignoredCodexBin = path.join(workspace, "node_modules", ".bin");
    await Promise.all([
      fsp.mkdir(selectedBin, { recursive: true }),
      fsp.mkdir(brokenBin, { recursive: true }),
      fsp.mkdir(reboundCodexBin, { recursive: true }),
      fsp.mkdir(callerNodeBin, { recursive: true }),
      fsp.mkdir(reboundNodeBin, { recursive: true }),
      fsp.mkdir(reboundCodeHome, { recursive: true }),
      fsp.mkdir(zdot),
      fsp.mkdir(projectBin),
      fsp.mkdir(ignoredCodexBin, { recursive: true }),
    ]);
    await writeFakePython(selectedExecutable, {
      executable: selectedCommand,
      prefix: selectedPrefix,
      basePrefix: selectedPrefix,
    });
    await fsp.symlink(selectedExecutable, selectedCommand);
    await fsp.writeFile(
      path.join(brokenBin, "python3"),
      "#!/bin/sh\necho 'xcrun: invalid active developer path' >&2\nexit 72\n",
      { mode: 0o755 },
    );
    await fsp.chmod(path.join(brokenBin, "python3"), 0o755);
    await writeFakeCodex(path.join(reboundCodexBin, "codex"));
    await writeNodeLauncher(path.join(callerNodeBin, "node"), "caller");
    await writeNodeLauncher(path.join(reboundNodeBin, "node"), "rebound");
    const reboundPath = [reboundNodeBin, reboundCodexBin, brokenBin, "/usr/bin", "/bin"]
      .join(path.delimiter);
    await fsp.writeFile(
      path.join(zdot, ".zshenv"),
      'case "${TMPDIR:-}" in */scratch) export FAKE_SCRATCH_AT_BIRTH=1 ;; ' +
        '*) unset FAKE_SCRATCH_AT_BIRTH ;; esac\n' +
        `export PATH=${shellQuote(reboundPath)}\n` +
        `export CODEX_HOME=${shellQuote(reboundCodeHome)}\n`,
    );
    await fsp.writeFile(
      path.join(projectBin, "cockpit-test"),
      "#!/bin/sh\nset -eu\nexec python3 -m unittest \"$@\"\n",
      { mode: 0o755 },
    );
    await fsp.chmod(path.join(projectBin, "cockpit-test"), 0o755);
    await fsp.writeFile(
      path.join(ignoredCodexBin, "codex"),
      "#!/bin/sh\nexit 99\n",
      { mode: 0o755 },
    );
    await fsp.chmod(path.join(ignoredCodexBin, "codex"), 0o755);
    await fsp.writeFile(path.join(workspace, ".gitignore"), "node_modules/\n");
    await fsp.writeFile(
      path.join(workspace, ".agenthub", "evals.json"),
      `${JSON.stringify({
        schema_version: 2,
        suite_id: "runtime-path-eval",
        cases: [{
          id: "run-normal-test-entrypoint",
          prompt: "Change locateTarget and run the repository test entrypoint.",
          answer_schema: "workspace-patch/v1",
        }],
      }, null, 2)}\n`,
    );
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "runtime path suite");
    const verifierDir = path.join(root, "runtime-verifier");
    const verifier = path.join(verifierDir, "verify");
    await fsp.mkdir(verifierDir);
    await fsp.writeFile(
      verifier,
      "#!/bin/sh\nset -eu\n" +
        "grep -qx 'selected-runtime' runtime-result.txt\n" +
        "grep -q '\"changed\"' src/app.js\n",
      { mode: 0o700 },
    );
    await fsp.chmod(verifier, 0o700);
    env = {
      ...env,
      PATH: [selectedBin, callerNodeBin, fakeBin, ignoredCodexBin, brokenBin, "/usr/bin", "/bin"]
        .join(path.delimiter),
      ZDOTDIR: zdot,
      AGENT_HUB_FORWARD_ENV:
        "ZDOTDIR,FAKE_REQUIRE_REBOUND_NODE,FAKE_REQUIRE_SCRATCH_BIRTH",
      FAKE_REQUIRE_REBOUND_NODE: "1",
      FAKE_REQUIRE_SCRATCH_BIRTH: "1",
    };

    const result = await invokeEval([verifier]);

    expect(result.summary).toMatchObject({ pass: 1, error: 0 });
    expect(result.isolation.data_read).toContain("detected-patch-runtime");
    expect(result.cases[0]).toMatchObject({
      status: "pass",
      reason: "verifier_passed",
      metrics: { verifier: { status: "passed", exit_code: 0 } },
    });
    const command = JSON.parse(await fsp.readFile(
      path.join(runDir, result.cases[0].agent_run_ref.run_id, "command.json"),
      "utf8",
    ));
    const request = JSON.parse(await fsp.readFile(
      path.join(runDir, result.cases[0].agent_run_ref.run_id, "request.json"),
      "utf8",
    ));
    const runtimeBin = request.execution_profile.path_prepend[0];
    const permissionProfile = command.argv.find(
      (item) => item.startsWith("permissions.agenthub-eval="),
    );
    expect(command.argv).toContain('shell_environment_policy.inherit="core"');
    expect(command.argv).toContain("allow_login_shell=false");
    expect(command.argv[0]).toBe(request.execution_profile.agent_executable);
    expect(command.argv[0]).toBe(await fsp.realpath(path.join(reboundCodexBin, "codex")));
    expect(request.execution_profile.agent_interpreter)
      .toBe(await fsp.realpath(path.join(reboundNodeBin, "node")));
    expect(command.launcher[4]).toBe(request.execution_profile.agent_interpreter);
    expect(path.isAbsolute(command.argv[0])).toBe(true);
    expect(command.env_keys).toContain("AGENT_HUB_INTERNAL_PATH_PREPEND");
    expect(permissionProfile).toContain(`${JSON.stringify(runtimeBin)} = "read"`);
    expect(pathIsInside(runtimeBin, request.cwd)).toBe(false);
    expect(pathIsInside(request.cwd, runtimeBin)).toBe(false);
    expect(pathIsInside(runtimeBin, request.execution_profile.scratch_path)).toBe(false);
    expect(pathIsInside(request.execution_profile.scratch_path, runtimeBin)).toBe(false);
    expect(request.execution_profile.runtime_read_paths.some(
      (item) => pathIsInside(item, workspace),
    )).toBe(false);
    expect(JSON.stringify(command)).not.toContain(env.PATH);
    expect((await fsp.readdir(root)).filter((name) => name.startsWith(".agenthub-eval-")))
      .toEqual([]);
  }, 20000);

  it("fails before dispatch when the detected runtime cannot pass the final profile", async () => {
    const selectedBin = path.join(root, "preflight-python", "bin");
    const selectedExecutable = path.join(selectedBin, "python3");
    await fsp.mkdir(selectedBin, { recursive: true });
    await writeFakePython(selectedExecutable, {
      executable: selectedExecutable,
      prefix: path.dirname(selectedBin),
      basePrefix: path.dirname(selectedBin),
    });
    await fsp.writeFile(
      path.join(workspace, ".agenthub", "evals.json"),
      `${JSON.stringify({
        schema_version: 2,
        suite_id: "runtime-preflight-error",
        cases: [{
          id: "must-not-dispatch",
          prompt: "Change locateTarget.",
          answer_schema: "workspace-patch/v1",
        }],
      }, null, 2)}\n`,
    );
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "runtime preflight suite");
    const verifierDir = path.join(root, "unused-verifier");
    const verifier = path.join(verifierDir, "verify");
    await fsp.mkdir(verifierDir);
    await fsp.writeFile(verifier, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fsp.chmod(verifier, 0o700);
    env = {
      ...env,
      PATH: [selectedBin, fakeBin, path.dirname(process.execPath), "/usr/bin", "/bin"]
        .join(path.delimiter),
      AGENT_HUB_FORWARD_ENV: "ZDOTDIR,FAKE_CODEX_SANDBOX_FAIL",
      FAKE_CODEX_SANDBOX_FAIL: "1",
    };

    const result = await invokeEval([verifier]);

    expect(result.summary).toMatchObject({ pass: 0, error: 1 });
    expect(result.isolation.data_read).not.toContain("detected-patch-runtime");
    expect(result.cases[0]).toMatchObject({
      status: "error",
      reason: "runtime_preflight_failed",
      agent_run_ref: null,
      metrics: { telemetry_status: "not-run" },
    });
    expect(await fsp.readdir(runDir).catch(() => [])).toEqual([]);
    expect((await fsp.readdir(root)).filter((name) => name.startsWith(".agenthub-eval-")))
      .toEqual([]);
  }, 20000);

  it("keeps verifier grading independent from patch telemetry and verifier output size", async () => {
    await fsp.writeFile(
      path.join(workspace, ".agenthub", "evals.json"),
      `${JSON.stringify({
        schema_version: 2,
        suite_id: "patch-telemetry-eval",
        cases: [{
          id: "change-with-unprojectable-patch",
          prompt: "Change the target and force patch telemetry unavailable.",
          answer_schema: "workspace-patch/v1",
        }],
      }, null, 2)}\n`,
    );
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "patch telemetry suite");
    const verifierDir = path.join(root, "large-verifier");
    const verifier = path.join(verifierDir, "verify");
    await fsp.mkdir(verifierDir);
    await fsp.writeFile(
      verifier,
      "#!/bin/sh\ndd if=/dev/zero bs=1048576 count=2 2>/dev/null\n" +
        "grep -q '\"changed\"' src/app.js\n",
      { mode: 0o700 },
    );
    await fsp.chmod(verifier, 0o700);

    const result = await invokeEval([verifier]);

    expect(result.cases[0]).toMatchObject({
      status: "pass",
      reason: "verifier_passed",
      metrics: {
        patch: { status: "unavailable" },
        verifier: { status: "passed", exit_code: 0 },
      },
    });
    expect((await fsp.readdir(root)).filter((name) => name.startsWith(".agenthub-eval-")))
      .toEqual([]);
  }, 20000);

  it("rejects a cwd-local Codex executable before running its version probe", async () => {
    const localBin = path.join(workspace, "local-codex-bin");
    const marker = path.join(root, "local-codex-executed");
    const zdot = path.join(root, "local-codex-zdot");
    await Promise.all([
      fsp.mkdir(localBin),
      fsp.mkdir(zdot),
    ]);
    await fsp.writeFile(
      path.join(localBin, "codex"),
      "#!/bin/sh\n" +
        `printf executed > ${shellQuote(marker)}\n` +
        "exit 99\n",
      { mode: 0o755 },
    );
    await fsp.chmod(path.join(localBin, "codex"), 0o755);
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "local codex fixture");
    await fsp.writeFile(
      path.join(zdot, ".zshenv"),
      `export PATH=${shellQuote([localBin, fakeBin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter))}\n`,
    );
    env = {
      ...env,
      ZDOTDIR: zdot,
      AGENT_HUB_FORWARD_ENV: "ZDOTDIR",
    };

    const failure = await invokeEvalFailure([], "codex");

    expect(failure.error).toMatchObject({
      code: "unsupported_isolation",
      message: "Codex CLI overlaps the evaluated workspace",
    });
    await expect(fsp.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a cwd-local env-shebang interpreter before running Codex", async () => {
    const localNodeBin = path.join(workspace, "local-node-bin");
    const marker = path.join(root, "local-node-executed");
    const zdot = path.join(root, "local-node-zdot");
    await Promise.all([
      fsp.mkdir(localNodeBin),
      fsp.mkdir(zdot),
    ]);
    await fsp.writeFile(
      path.join(localNodeBin, "node"),
      "#!/bin/sh\n" +
        `printf executed > ${shellQuote(marker)}\n` +
        `exec ${shellQuote(process.execPath)} \"$@\"\n`,
      { mode: 0o755 },
    );
    await fsp.chmod(path.join(localNodeBin, "node"), 0o755);
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-m", "local node fixture");
    await fsp.writeFile(
      path.join(zdot, ".zshenv"),
      `export PATH=${shellQuote([localNodeBin, fakeBin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter))}\n`,
    );
    env = {
      ...env,
      ZDOTDIR: zdot,
      AGENT_HUB_FORWARD_ENV: "ZDOTDIR",
    };

    const failure = await invokeEvalFailure([], "codex");

    expect(failure.error).toMatchObject({
      code: "unsupported_isolation",
      message: "Codex CLI interpreter node overlaps the evaluated workspace",
    });
    await expect(fsp.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before collecting answers when the provider cannot enforce the whitelist", async () => {
    const failure = await invokeEvalFailure([], "claude-code");
    expect(failure).toEqual({
      error: {
        code: "unsupported_isolation",
        message: "Eval workspace-readonly/v1 currently supports only codex",
      },
    });
  });

  it("requires model and effort before collecting standards", async () => {
    const missingModel = await invokeRawFailure([
      "eval", "run", "--agent", "codex", "--effort", "medium", "--cwd", workspace,
    ]);
    expect(missingModel).toEqual({
      error: { code: "invalid_cli_usage", message: "--model is required" },
    });
    const missingEffort = await invokeRawFailure([
      "eval", "run", "--agent", "codex", "--model", "gpt-test", "--cwd", workspace,
    ]);
    expect(missingEffort).toEqual({
      error: { code: "invalid_cli_usage", message: "--effort is required" },
    });
  });

  async function invokeEval(answers, agent = "codex", suite = undefined) {
    const args = [
      env.AGENT_HUB_TEST_HELPER,
      "eval",
      "run",
      "--agent",
      agent,
      "--model",
      "gpt-test",
      "--effort",
      "medium",
      "--cwd",
      workspace,
      "--timeout-ms",
      "10000",
    ];
    if (suite !== undefined) args.push("--suite", suite);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      args,
      {
        cwd: path.dirname(CLI_PATH),
        env: { ...env, AGENT_HUB_TEST_ANSWERS: JSON.stringify(answers) },
        timeout: 15000,
      },
    );
    expect(stderr).toContain("Standard answers accepted");
    return JSON.parse(stdout);
  }

  async function invokeEvalFailure(answers, agent) {
    return invokeRawFailure([
      "eval", "run", "--agent", agent,
      "--model", "gpt-test", "--effort", "medium", "--cwd", workspace,
    ], answers);
  }

  async function invokeRawFailure(args, answers = []) {
    try {
      await execFileAsync(
        process.execPath,
        [env.AGENT_HUB_TEST_HELPER, ...args],
        {
          cwd: path.dirname(CLI_PATH),
          env: { ...env, AGENT_HUB_TEST_ANSWERS: JSON.stringify(answers) },
          timeout: 15000,
        },
      );
      throw new Error("Eval unexpectedly succeeded");
    } catch (error) {
      return JSON.parse(error.stderr);
    }
  }
});

async function writeFakeCodex(target) {
  await fsp.writeFile(
    target,
    `#!/usr/bin/env node
const fs = require("node:fs");
const childProcess = require("node:child_process");
const args = process.argv.slice(2);
if (process.env.FAKE_REQUIRE_REBOUND_NODE === "1" && process.env.FAKE_NODE_KIND !== "rebound") {
  process.exit(23);
}
if (
  process.env.FAKE_REQUIRE_SCRATCH_BIRTH === "1" &&
  (args[0] === "sandbox" || args[0] === "exec") &&
  process.env.FAKE_SCRATCH_AT_BIRTH !== "1"
) process.exit(24);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.151.0\\n");
  process.exit(0);
}
if (args[0] === "debug" && args[1] === "models") {
  process.stdout.write(JSON.stringify({ models: [{
    slug: "gpt-test",
    display_name: "GPT Test",
    visibility: "list",
    priority: 1,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    context_window: 100000,
    input_modalities: ["text"]
  }] }));
  process.exit(0);
}
if (args[0] === "sandbox") {
  if (process.env.FAKE_CODEX_SANDBOX_FAIL === "1") process.exit(17);
  if (!args.includes("--include-managed-config")) process.exit(21);
  const codeHome = String(process.env.CODEX_HOME || "");
  if (
    !codeHome.endsWith("/preflight-codex-home") &&
    !codeHome.endsWith("/codex-home") &&
    !codeHome.endsWith("/rebound-codex-home")
  ) process.exit(22);
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) process.exit(18);
  const command = args.slice(separator + 1);
  const child = childProcess.spawnSync(command[0], command.slice(1), {
    env: process.env,
    encoding: "utf8",
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) {
    process.stderr.write(child.error.message + "\\n");
    process.exit(19);
  }
  process.exit(Number.isInteger(child.status) ? child.status : 20);
}
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const threadId = "019f38ae-357d-7db3-89fb-670f88316240";
  const patchEval = input.includes("Implement the requested change");
  if (patchEval) {
    fs.writeFileSync("src/app.js", 'export function locateTarget() { return "changed"; }\\n');
    if (fs.existsSync("bin/cockpit-test")) {
      const runtimeResult = childProcess.execFileSync("./bin/cockpit-test", [], {
        encoding: "utf8",
        env: process.env,
      });
      fs.writeFileSync("runtime-result.txt", runtimeResult.trim() + "\\n");
    }
    if (input.includes("force patch telemetry unavailable")) {
      childProcess.execFileSync("git", ["init", "nested"]);
      fs.writeFileSync("nested/file.txt", "nested\\n");
    }
  }
  const output = patchEval
    ? JSON.stringify({ status: "completed" })
    : JSON.stringify({ path: "src/app.js", symbol: "locateTarget", definition_line: 1 });
  const events = [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.started", item: { id: "tool-1", type: "command_execution", command: "/bin/zsh -lc \\\"nl -ba src/app.js | sed -n 1p\\\"" } },
    { type: "item.completed", item: { id: "tool-1", type: "command_execution", command: "/bin/zsh -lc \\\"nl -ba src/app.js | sed -n 1p\\\"", status: "completed", exit_code: 0, aggregated_output: "ok" } },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: output } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } }
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
});
`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

async function writeNodeLauncher(target, kind) {
  await fsp.writeFile(
    target,
    "#!/bin/sh\n" +
      `export FAKE_NODE_KIND=${shellQuote(kind)}\n` +
      `exec ${shellQuote(process.execPath)} \"$@\"\n`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

async function writeFakePython(target, { executable, prefix, basePrefix }) {
  const identity = JSON.stringify([executable, prefix, basePrefix]);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(
    target,
    "#!/bin/sh\n" +
      `if [ "\${1:-}" = "-I" ] && [ "\${2:-}" = "-S" ] && [ "\${3:-}" = "-c" ]; then ` +
      `printf '%s\\n' ${shellQuote(identity)}; exit 0; fi\n` +
      "if [ \"${1:-}\" = \"-m\" ] && [ \"${2:-}\" = \"unittest\" ]; then\n" +
      "  [ -z \"${AGENT_HUB_INTERNAL_PATH_PREPEND:-}\" ] || exit 91\n" +
      "  case \"${PATH:-}\" in */runtime-bin:*) ;; *) exit 92 ;; esac\n" +
      "  command -v codex >/dev/null 2>&1 || exit 93\n" +
      "  printf '%s\\n' selected-runtime\n" +
      "  exit 0\n" +
      "fi\n" +
      "exit 94\n",
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function allText(root) {
  const chunks = [];
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) chunks.push(await fsp.readFile(target, "utf8"));
    }
  }
  await visit(root);
  return chunks.join("\n");
}

function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

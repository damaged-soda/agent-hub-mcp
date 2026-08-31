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
  let env;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-eval-cli-"));
    workspace = path.join(root, "workspace");
    runDir = path.join(root, "runs");
    evalDir = path.join(root, "evals");
    const fakeBin = path.join(root, "bin");
    await fsp.mkdir(path.join(workspace, ".agenthub"), { recursive: true });
    await fsp.mkdir(path.join(workspace, "src"), { recursive: true });
    await fsp.mkdir(fakeBin, { recursive: true });
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
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const threadId = "019f38ae-357d-7db3-89fb-670f88316240";
  const patchEval = input.includes("Implement the requested change");
  if (patchEval) {
    fs.writeFileSync("src/app.js", 'export function locateTarget() { return "changed"; }\\n');
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

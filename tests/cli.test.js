import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { questionUntilClosed } from "../src/cli.js";
import { REVIEW_DEPTH_ENV } from "../src/review-context.js";

const CLI_PATH = path.resolve("src/cli.js");

describe("agenthub CLI", () => {
  let root;
  let workspace;
  let bin;
  let env;
  let internalDispatchHelper;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-cli-test-"));
    workspace = path.join(root, "workspace");
    bin = path.join(root, "bin");
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(bin, { recursive: true });
    await writeFakeClaude(path.join(bin, "claude"));
    await writeFakeCodex(path.join(bin, "codex"));
    const claudeConfigDir = path.join(root, "claude");
    await fsp.mkdir(claudeConfigDir, { recursive: true });
    env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      AGENT_HUB_RUN_DIR: path.join(root, "runs"),
      AGENT_HUB_DISCUSSION_DIR: path.join(root, "discussions"),
      AGENT_HUB_REVIEW_CONFIG: path.join(root, "config", "review-routing.json"),
      AGENT_HUB_CATALOG_CACHE_DIR: path.join(root, "catalog-cache"),
      AGENT_HUB_CWD_ALLOWLIST: workspace,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    };
    delete env[REVIEW_DEPTH_ENV];
    internalDispatchHelper = path.join(root, "internal-dispatch.mjs");
    await fsp.writeFile(
      internalDispatchHelper,
      `import { dispatchToAgent, waitAgentRun } from ${JSON.stringify(
        pathToFileURL(path.resolve("src/runs.js")).href,
      )};
const payload = JSON.parse(process.env.AGENT_HUB_TEST_INTERNAL_DISPATCH);
try {
  const accepted = await dispatchToAgent(payload.input, {
    execution_profile: payload.execution_profile,
  });
  const snapshot = payload.wait === false ? null : await waitAgentRun({
    run_ref: accepted.run_ref,
    timeout_ms: 10000,
    poll_interval_ms: 25,
  });
  process.stdout.write(JSON.stringify({ accepted, snapshot }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    error: { code: error?.code ?? null, message: error?.message ?? String(error) },
  }));
}
`,
      { mode: 0o600 },
    );
  });

  afterEach(async () => {
    await fsp.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  it("fails an interactive eval question when stdin closes", async () => {
    const promptInterface = new EventEmitter();
    promptInterface.question = () => new Promise(() => undefined);
    const pending = questionUntilClosed(promptInterface, "standard path: ");
    promptInterface.emit("close");
    await expect(pending).rejects.toMatchObject({ code: "interactive_eval_required" });
  });

  it("dispatches and waits across separate CLI processes", async () => {
    const accepted = await runCli(
      [
        "dispatch",
        "--agent",
        "claude-code",
        "--cwd",
        workspace,
        "--prompt",
        "review this",
      ],
      env,
    );

    expect(accepted.status).toBe("accepted");
    const completed = await runCli(
      ["wait", accepted.run_ref.run_id, "--timeout-ms", "10000"],
      env,
    );

    expect(completed.status).toBe("completed");
    expect(completed.content[0].text).toBe("fake result: review this");
  });

  it("births the agent through zsh at the run cwd with NS_REBIND=1 and records the real launcher argv", async () => {
    // 假 ZDOTDIR：.zshenv 只记录出生 cwd 与收到的会话轴状态（真实 glue 的契约由下一条用真 ns-resolve 验）
    const zdot = path.join(root, "zdot");
    await fsp.mkdir(zdot, { recursive: true });
    await fsp.writeFile(path.join(zdot, ".zshenv"), 'export BORN_CWD="$PWD"\nexport NS="glue-saw-${NS:-none}"\n');
    const accepted = await runCli(
      ["dispatch", "--agent", "claude-code", "--cwd", workspace, "--prompt", "dump-env"],
      { ...env, NS: "caller-domain", NS_UNDO: "unset NS", LEAK: "from-caller", ZDOTDIR: zdot, AGENT_HUB_FORWARD_ENV: "ZDOTDIR", AGENT_HUB_REQUIRE_NAMESPACE: "1" },
    );
    expect(accepted.status).toBe("accepted");
    const completed = await runCli(["wait", accepted.run_ref.run_id, "--timeout-ms", "10000"], env);
    expect(completed.status).toBe("completed");
    expect(JSON.parse(completed.content[0].text)).toEqual({
      NS: "glue-saw-caller-domain", NS_UNDO: "unset NS", NS_REBIND: "1",
      BORN_CWD: await fsp.realpath(workspace), LEAK: null,
    });
    const command = JSON.parse(await fsp.readFile(path.join(env.AGENT_HUB_RUN_DIR, accepted.run_ref.run_id, "command.json"), "utf8"));
    expect(command.launcher.slice(0, 3)).toEqual(["/bin/zsh", "-c", 'exec "$0" "$@"']);
    expect(command.launcher.slice(3)).toEqual(command.argv);
  });

  it("injects a setup-token after zsh birth without exposing it to artifacts or Codex", async () => {
    const token = "unit-test-long-lived-oauth-token";
    let tokenFile = path.join(root, "claude-setup-token");
    const zdot = path.join(root, "auth-zdot");
    await fsp.mkdir(zdot);
    await fsp.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await fsp.chmod(tokenFile, 0o600);
    tokenFile = await fsp.realpath(tokenFile);
    await fsp.writeFile(
      path.join(zdot, ".zshenv"),
      "unset CLAUDE_CODE_OAUTH_TOKEN\n" +
        "export ANTHROPIC_API_KEY=wrong-api-key\n" +
        "export ANTHROPIC_AUTH_TOKEN=wrong-auth-token\n" +
        "export ANTHROPIC_BASE_URL=https://wrong.invalid\n" +
        "export CLAUDE_CODE_OAUTH_REFRESH_TOKEN=wrong-refresh\n" +
        "export CLAUDE_CODE_OAUTH_SCOPES=wrong-scope\n" +
        "export CLAUDE_CODE_USE_BEDROCK=1\n" +
        "export CLAUDE_CODE_USE_VERTEX=1\n" +
        "export CLAUDE_CODE_USE_FOUNDRY=1\n",
    );
    const authEnv = {
      ...env,
      ZDOTDIR: zdot,
      AGENT_HUB_CLAUDE_OAUTH_TOKEN_FILE: tokenFile,
      CLAUDE_CODE_OAUTH_TOKEN: "stale-caller-token",
      AGENT_HUB_FORWARD_ENV:
        "ZDOTDIR,AGENT_HUB_CLAUDE_OAUTH_TOKEN_FILE,CLAUDE_CODE_OAUTH_TOKEN",
    };

    const accepted = await runCli(
      ["dispatch", "--agent", "claude-code", "--cwd", workspace, "--prompt", "dump-auth-env"],
      authEnv,
    );
    const completed = await runCli(
      ["wait", accepted.run_ref.run_id, "--timeout-ms", "10000"],
      authEnv,
    );
    expect(completed.status).toBe("completed");
    expect(JSON.parse(completed.content[0].text)).toEqual({
      oauth_matches: true,
      oauth_file: null,
      anthropic_api_key: null,
      anthropic_auth_token: null,
      anthropic_base_url: null,
      oauth_refresh_token: null,
      oauth_scopes: null,
      bedrock: null,
      vertex: null,
      foundry: null,
      internal_keys: [],
    });

    const runPath = path.join(env.AGENT_HUB_RUN_DIR, accepted.run_ref.run_id);
    const artifactBodies = await Promise.all(
      (await fsp.readdir(runPath)).map(async (name) => {
        const target = path.join(runPath, name);
        return (await fsp.stat(target)).isFile() ? fsp.readFile(target, "utf8") : "";
      }),
    );
    expect(artifactBodies.join("\n")).not.toContain(token);
    expect(artifactBodies.join("\n")).not.toContain(tokenFile);

    const codexAccepted = await runCli(
      ["dispatch", "--agent", "codex", "--cwd", workspace, "--prompt", "dump-auth-env"],
      authEnv,
    );
    const codexCompleted = await runCli(
      ["wait", codexAccepted.run_ref.run_id, "--timeout-ms", "10000"],
      authEnv,
    );
    expect(codexCompleted.status).toBe("completed");
    expect(JSON.parse(codexCompleted.content[0].text)).toEqual({
      oauth_token: null,
      oauth_file: null,
    });
  }, 15000);

  it("fails before spawning Claude when the configured token file is not private", async () => {
    const tokenFile = path.join(root, "loose-claude-setup-token");
    await fsp.writeFile(tokenFile, "unit-test-secret\n", { mode: 0o644 });
    await fsp.chmod(tokenFile, 0o644);
    const accepted = await runCli(
      ["dispatch", "--agent", "claude-code", "--cwd", workspace, "--prompt", "review this"],
      { ...env, AGENT_HUB_CLAUDE_OAUTH_TOKEN_FILE: tokenFile },
    );
    const failed = await runCli(
      ["wait", accepted.run_ref.run_id, "--timeout-ms", "10000"],
      env,
    );

    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({
      code: "claude_oauth_token_file_invalid",
      retryable: false,
    });
    await expect(fsp.stat(path.join(
      env.AGENT_HUB_RUN_DIR,
      accepted.run_ref.run_id,
      "command.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepends execution-profile runtime paths after zsh birth without leaking the handoff value", async () => {
    const runtimeA = path.join(root, "runtime-a");
    const runtimeB = path.join(root, "runtime-b");
    const scratch = path.join(root, "scratch");
    const schema = path.join(scratch, "schema.json");
    const postZshBin = path.join(root, "post-zsh-bin");
    const postZshTmp = path.join(root, "post-zsh-tmp");
    const zdot = path.join(root, "path-zdot");
    const nodeExecutable = await fsp.realpath(process.execPath);
    await Promise.all([
      fsp.mkdir(runtimeA),
      fsp.mkdir(runtimeB),
      fsp.mkdir(scratch),
      fsp.mkdir(postZshBin),
      fsp.mkdir(zdot),
    ]);
    await fsp.writeFile(schema, "{}\n", { mode: 0o600 });
    await fsp.writeFile(path.join(runtimeA, "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    await fsp.chmod(path.join(runtimeA, "codex"), 0o755);
    await fsp.writeFile(path.join(runtimeA, "node"), "#!/bin/sh\nexit 98\n", { mode: 0o755 });
    await fsp.chmod(path.join(runtimeA, "node"), 0o755);
    const zshPath = [
      postZshBin,
      path.dirname(process.execPath),
      bin,
      "/usr/bin",
      "/bin",
    ].join(path.delimiter);
    await fsp.writeFile(
      path.join(zdot, ".zshenv"),
      `export PATH=${JSON.stringify(zshPath)}\n` +
        `export TMPDIR=${JSON.stringify(postZshTmp)} TMP=${JSON.stringify(postZshTmp)} TEMP=${JSON.stringify(postZshTmp)}\n` +
        'export PATH_AFTER_ZSH="$PATH" TMP_AFTER_ZSH="$TMPDIR"\n',
    );

    const dispatched = await runInternalDispatch(
      internalDispatchHelper,
      {
        input: {
          agent_id: "codex",
          cwd: workspace,
          prompt: "dump-path-handoff",
          metadata: {},
        },
        execution_profile: {
          kind: "workspace-write/v1",
          scratch_path: scratch,
          output_schema_path: schema,
          agent_executable: path.join(bin, "codex"),
          agent_interpreter: nodeExecutable,
          runtime_read_paths: [bin, path.dirname(nodeExecutable), runtimeA, runtimeB],
          path_prepend: [runtimeA, runtimeA, runtimeB],
        },
      },
      {
        ...env,
        ZDOTDIR: zdot,
        AGENT_HUB_FORWARD_ENV:
          "ZDOTDIR,AGENT_HUB_INTERNAL_PATH_PREPEND,AGENT_HUB_INTERNAL_POST_BIRTH_0",
        AGENT_HUB_INTERNAL_PATH_PREPEND: path.join(root, "caller-spoofed-prefix"),
        AGENT_HUB_INTERNAL_POST_BIRTH_0: "caller-spoofed-value",
      },
    );

    expect(dispatched.error).toBeUndefined();
    expect(dispatched.snapshot.status).toBe("completed");
    const seen = JSON.parse(dispatched.snapshot.content[0].text);
    const realScratch = await fsp.realpath(scratch);
    const realRuntimeA = await fsp.realpath(runtimeA);
    const realRuntimeB = await fsp.realpath(runtimeB);
    expect(seen.path_after_zsh).toBe(zshPath);
    expect(seen.tmp_after_zsh).toBe(postZshTmp);
    expect(seen.tmpdir).toBe(realScratch);
    expect(seen.tmp).toBe(realScratch);
    expect(seen.temp).toBe(realScratch);
    expect(seen.path.split(path.delimiter)).toEqual([
      realRuntimeA,
      realRuntimeB,
      ...zshPath.split(path.delimiter),
    ]);
    expect(seen.internal_path_prepend).toBeNull();
    expect(seen.internal_keys).toEqual([]);

    const runPath = path.join(env.AGENT_HUB_RUN_DIR, dispatched.accepted.run_ref.run_id);
    const command = JSON.parse(await fsp.readFile(path.join(runPath, "command.json"), "utf8"));
    const request = JSON.parse(await fsp.readFile(path.join(runPath, "request.json"), "utf8"));
    const joinedPrefix = [realRuntimeA, realRuntimeB].join(path.delimiter);
    expect(command.env_keys).toContain("AGENT_HUB_INTERNAL_PATH_PREPEND");
    expect(command.env_keys).toEqual(expect.arrayContaining([
      "AGENT_HUB_INTERNAL_POST_BIRTH_0",
      "AGENT_HUB_INTERNAL_POST_BIRTH_1",
      "AGENT_HUB_INTERNAL_POST_BIRTH_2",
    ]));
    expect(command.launcher[2]).toContain("AGENT_HUB_INTERNAL_PATH_PREPEND");
    expect(command.launcher[4]).toBe(nodeExecutable);
    expect(command.launcher[2].indexOf('__agent_hub_interpreter="$1"')).toBeLessThan(
      command.launcher[2].indexOf("export PATH="),
    );
    expect(JSON.stringify(command)).not.toContain(joinedPrefix);
    expect(request.execution_profile.path_prepend).toEqual([realRuntimeA, realRuntimeB]);
  }, 15000);

  it("rejects unsafe execution-profile PATH prefixes before creating a run", async () => {
    const runtime = path.join(root, "runtime-safe");
    const uncovered = path.join(root, "runtime-uncovered");
    const scratch = path.join(root, "profile-scratch");
    const scratchBin = path.join(scratch, "bin");
    const workspaceBin = path.join(workspace, "bin");
    const workspaceParent = path.dirname(workspace);
    const scratchParent = path.join(root, "isolated-scratch-parent");
    const nestedScratch = path.join(scratchParent, "scratch");
    const nestedSchema = path.join(nestedScratch, "schema.json");
    const runtimeFile = path.join(root, "runtime-file");
    const schema = path.join(scratch, "schema.json");
    const nodeExecutable = await fsp.realpath(process.execPath);
    const nodeBin = path.dirname(nodeExecutable);
    await Promise.all([
      fsp.mkdir(runtime),
      fsp.mkdir(uncovered),
      fsp.mkdir(scratchBin, { recursive: true }),
      fsp.mkdir(workspaceBin),
      fsp.mkdir(nestedScratch, { recursive: true }),
    ]);
    await fsp.writeFile(runtimeFile, "not a directory\n");
    await fsp.writeFile(schema, "{}\n", { mode: 0o600 });
    await fsp.writeFile(nestedSchema, "{}\n", { mode: 0o600 });
    const baseProfile = {
      kind: "workspace-write/v1",
      scratch_path: scratch,
      output_schema_path: schema,
      agent_executable: path.join(bin, "codex"),
      agent_interpreter: nodeExecutable,
      runtime_read_paths: [bin, nodeBin, runtime],
    };
    const invalidProfiles = [
      {
        profile: { ...baseProfile, path_prepend: runtime },
        message: "execution_profile.path_prepend must be an array",
      },
      {
        profile: { ...baseProfile, path_prepend: ["relative/runtime"] },
        message: "execution_profile.path_prepend[0] must be absolute",
      },
      {
        profile: {
          ...baseProfile,
          runtime_read_paths: [bin, nodeBin, runtimeFile],
          path_prepend: [runtimeFile],
        },
        message: "execution_profile.path_prepend[0] must be a directory",
      },
      {
        profile: { ...baseProfile, path_prepend: [uncovered] },
        message: "execution_profile.path_prepend[0] must be covered by runtime_read_paths",
      },
      {
        profile: {
          ...baseProfile,
          runtime_read_paths: [bin, nodeBin, workspaceBin],
          path_prepend: [workspaceBin],
        },
        message: "execution_profile.path_prepend[0] must be separate from cwd",
      },
      {
        profile: {
          ...baseProfile,
          runtime_read_paths: [bin, nodeBin, scratchBin],
          path_prepend: [scratchBin],
        },
        message: "execution_profile.path_prepend[0] must be separate from scratch_path",
      },
      {
        profile: {
          ...baseProfile,
          runtime_read_paths: [bin, nodeBin, workspaceParent],
          path_prepend: [workspaceParent],
        },
        message: "execution_profile.path_prepend[0] must be separate from cwd",
      },
      {
        profile: {
          ...baseProfile,
          scratch_path: nestedScratch,
          output_schema_path: nestedSchema,
          runtime_read_paths: [bin, nodeBin, scratchParent],
          path_prepend: [scratchParent],
        },
        message: "execution_profile.path_prepend[0] must be separate from scratch_path",
      },
    ];

    for (const { profile, message } of invalidProfiles) {
      const dispatched = await runInternalDispatch(
        internalDispatchHelper,
        {
          input: {
            agent_id: "codex",
            cwd: workspace,
            prompt: "must not run",
            metadata: {},
          },
          execution_profile: profile,
          wait: false,
        },
        env,
      );
      expect(dispatched.error?.message).toBe(message);
    }
    await expect(fsp.readdir(env.AGENT_HUB_RUN_DIR)).resolves.toEqual([]);
  }, 15000);

  it("pins execution-profile agent commands to a covered executable outside writable roots", async () => {
    const scratch = path.join(root, "agent-executable-scratch");
    const schema = path.join(scratch, "schema.json");
    const uncovered = path.join(root, "uncovered-codex");
    const blocked = path.join(root, "blocked-codex");
    const envShebang = path.join(root, "env-shebang-codex");
    const workspaceExecutable = path.join(workspace, "workspace-codex");
    const scratchExecutable = path.join(scratch, "scratch-codex");
    await fsp.mkdir(scratch, { recursive: true });
    await fsp.writeFile(schema, "{}\n", { mode: 0o600 });
    for (const executable of [uncovered, workspaceExecutable, scratchExecutable]) {
      await fsp.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await fsp.chmod(executable, 0o755);
    }
    await fsp.writeFile(envShebang, "#!/usr/bin/env -S node\nprocess.exit(0);\n", { mode: 0o755 });
    await fsp.chmod(envShebang, 0o755);
    await fsp.writeFile(blocked, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const baseProfile = {
      kind: "workspace-write/v1",
      scratch_path: scratch,
      output_schema_path: schema,
      runtime_read_paths: [bin],
      path_prepend: [],
    };
    const invalidProfiles = [
      {
        profile: baseProfile,
        message: "execution_profile.agent_executable must be absolute",
      },
      {
        profile: { ...baseProfile, agent_executable: "codex" },
        message: "execution_profile.agent_executable must be absolute",
      },
      {
        profile: { ...baseProfile, agent_executable: path.join(root, "missing-codex") },
        message: "execution_profile.agent_executable must be an executable file",
      },
      {
        profile: { ...baseProfile, agent_executable: blocked },
        message: "execution_profile.agent_executable must be an executable file",
      },
      {
        profile: { ...baseProfile, agent_executable: envShebang },
        message: "execution_profile.agent_executable has an unsupported env shebang",
      },
      {
        profile: { ...baseProfile, agent_executable: uncovered },
        message: "execution_profile.agent_executable must be covered by runtime_read_paths",
      },
      {
        profile: {
          ...baseProfile,
          agent_executable: workspaceExecutable,
          runtime_read_paths: [workspace],
        },
        message: "execution_profile.agent_executable must be separate from cwd",
      },
      {
        profile: {
          ...baseProfile,
          agent_executable: scratchExecutable,
          runtime_read_paths: [scratch],
        },
        message: "execution_profile.agent_executable must be separate from scratch_path",
      },
    ];

    for (const { profile, message } of invalidProfiles) {
      const dispatched = await runInternalDispatch(
        internalDispatchHelper,
        {
          input: {
            agent_id: "codex",
            cwd: workspace,
            prompt: "must not run",
            metadata: {},
          },
          execution_profile: profile,
          wait: false,
        },
        env,
      );
      expect(dispatched.error?.message).toBe(message);
    }
    await expect(fsp.readdir(env.AGENT_HUB_RUN_DIR)).resolves.toEqual([]);
  }, 15000);

  // 真实契约：用 charter 的 ns-resolve 当 glue（本机 ~/ns/.charter，或 AGENT_HUB_TEST_NS_RESOLVE 指定；
  // 不支持 NS_REBIND 的旧版或缺位时跳过）。假 HOME 下造两个域，调用方带着 A 域派发到 B 域仓：
  // agent 必须看到 B 的域变量、看不到 A 的、看不到 NS_REBIND。
  const realResolver = process.env.AGENT_HUB_TEST_NS_RESOLVE ?? path.join(os.homedir(), "ns", ".charter", "scripts", "ns-resolve");
  const resolverSupportsRebind = fs.existsSync(realResolver) && fs.readFileSync(realResolver, "utf8").includes("NS_REBIND");
  it.skipIf(!resolverSupportsRebind)("with charter's real ns-resolve as glue: inherited domain unloaded, run-cwd domain bound, marker consumed", async () => {
    const fakeHome = path.join(root, "fake-home");
    // 域判据文件两种布局都造（charter 2026-08-22 质料树重切前 github/config/git-identity、后 git/identity），
    // 让本判例对重切前后的 ns-resolve 都成立
    for (const d of ["da", "db"]) {
      for (const marker of [["github", "config", "git-identity"], ["git", "identity"]]) {
        await fsp.mkdir(path.join(fakeHome, "ns", d, ...marker.slice(0, -1)), { recursive: true });
        await fsp.writeFile(path.join(fakeHome, "ns", d, ...marker), "");
      }
      await fsp.mkdir(path.join(fakeHome, "ns", d, "bin"), { recursive: true });
      await fsp.writeFile(path.join(fakeHome, "ns", d, "env"), `export ${d.toUpperCase()}_FLAG=on\n`);
      await fsp.mkdir(path.join(fakeHome, "work", d), { recursive: true });
    }
    await fsp.mkdir(path.join(fakeHome, "ns", ".charter", "scripts"), { recursive: true });
    await fsp.symlink(realResolver, path.join(fakeHome, "ns", ".charter", "scripts", "ns-resolve"));
    await fsp.writeFile(path.join(fakeHome, ".zshenv"), 'eval "$("$HOME/ns/.charter/scripts/ns-resolve" --shell=zsh)"\n');
    const target = path.join(fakeHome, "work", "db");
    await fsp.mkdir(path.join(target, "repo"), { recursive: true });
    // 调用方带着 da 域：NS_UNDO 是 ns-resolve 当初绑定 da 时记下的撤销语句（含精确剥段）
    const daBin = path.join(fakeHome, "ns", "da", "bin");
    const callerEnv = { ...env, HOME: fakeHome, AGENT_HUB_CWD_ALLOWLIST: target, NS: "da", NS_UNDO: `unset DA_FLAG;unset NS;__ns_path_strip lit '${daBin}'`, DA_FLAG: "on", PATH: `${daBin}:${env.PATH}` };
    const accepted = await runCli(["dispatch", "--agent", "claude-code", "--cwd", path.join(target, "repo"), "--prompt", "dump-env2"], callerEnv);
    expect(accepted.status).toBe("accepted");
    const completed = await runCli(["wait", accepted.run_ref.run_id, "--timeout-ms", "15000"], callerEnv);
    expect(completed.status).toBe("completed");
    const seen = JSON.parse(completed.content[0].text);
    expect(seen.NS).toBe("db");
    expect(seen.DB_FLAG).toBe("on");
    expect(seen.DA_FLAG).toBeNull();
    expect(seen.NS_REBIND).toBeNull();
    expect(seen.PATH.split(":")).toContain(path.join(fakeHome, "ns", "db", "bin"));
    expect(seen.PATH.split(":")).not.toContain(path.join(fakeHome, "ns", "da", "bin"));
  });

  it("returns structured errors for invalid CLI input", async () => {
    const invalidTimeout = await runCliFailure(
      ["wait", "not-used", "--timeout-ms", "0"],
      env,
    );
    expect(invalidTimeout).toEqual({
      error: {
        code: "invalid_cli_usage",
        message: "--timeout-ms must be a positive integer",
      },
    });

    const invalidJson = await runCliFailure(["dispatch", "--json", "{"], env);
    expect(invalidJson.error.code).toBe("invalid_cli_usage");
    expect(invalidJson.error.message).toMatch(/^--json is invalid:/);
  });

  it("writes structured worker diagnostics for a rejected Discussion preflight", async () => {
    const rejected = await runCliFailure(
      [
        "discussion",
        "dispatch",
        "--json",
        JSON.stringify({
          kind: "new",
          objective: "invalid request",
          question: "missing roster",
          cwd: workspace,
          materials: [],
        }),
      ],
      env,
    );
    expect(rejected.error.message).toMatch(/Invalid input/);

    const logPath = path.join(env.AGENT_HUB_DISCUSSION_DIR, ".workers.log");
    const records = await waitForWorkerLog(logPath, "worker.failed");
    expect(records.every((record) => record.schema_version === 1 && record.timestamp)).toBe(true);
    expect(records.at(-1)).toMatchObject({
      event: "worker.failed",
      mode: "dispatch",
      discussion_id: null,
      error: { code: "discussion_worker_error" },
    });
    expect(JSON.stringify(records)).not.toContain("stack");
  });

  it("persists a review route and dispatches it without model discovery", async () => {
    const invocationLog = path.join(root, "claude-invocations.jsonl");
    const reviewEnv = {
      ...env,
      AGENT_HUB_FORWARD_ENV: "FAKE_CLAUDE_INVOCATION_LOG",
      FAKE_CLAUDE_INVOCATION_LOG: invocationLog,
    };
    const initial = await runCli(["review", "status", "--cwd", workspace], reviewEnv);
    expect(initial.kind).toBe("agent-review-config");
    expect(initial.routes.find((route) => route.requester === "codex")).toMatchObject({
      reviewer: "claude-code",
      model: "default",
      source: "default",
    });

    const updated = await runCli([
      "review", "set",
      "--requester", "codex",
      "--reviewer", "claude-code",
      "--model", "haiku",
      "--cwd", workspace,
    ], reviewEnv);
    expect(updated.routes.find((route) => route.requester === "codex")).toMatchObject({
      reviewer: "claude-code",
      model: "haiku",
      source: "override",
    });

    await fsp.writeFile(invocationLog, "");
    const accepted = await runCli([
      "review", "dispatch",
      "--requester", "codex",
      "--cwd", workspace,
      "--prompt", "review via route",
    ], reviewEnv);
    const completed = await runCli(
      ["wait", accepted.run_ref.run_id, "--timeout-ms", "10000"],
      reviewEnv,
    );
    expect(completed.status).toBe("completed");
    expect(completed.content[0].text).toBe("fake result: review via route");
    const command = JSON.parse(await fsp.readFile(
      path.join(env.AGENT_HUB_RUN_DIR, accepted.run_ref.run_id, "command.json"),
      "utf8",
    ));
    expect(command.argv).toContain("haiku");
    expect(command.env_keys).toEqual(expect.arrayContaining([
      "AGENT_HUB_REVIEW_DEPTH",
    ]));
    const request = JSON.parse(await fsp.readFile(
      path.join(env.AGENT_HUB_RUN_DIR, accepted.run_ref.run_id, "request.json"),
      "utf8",
    ));
    expect(request.review_context).toEqual({
      version: 1,
      requester: "codex",
      reviewer: "claude-code",
      depth: 1,
    });
    expect(request.prompt).toContain("AGENT_HUB_REVIEW_PROTOCOL_V1");
    expect(request.prompt).toContain("review via route");
    const invocationKinds = (await fsp.readFile(invocationLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).kind);
    expect(invocationKinds).toEqual(["version", "run"]);
    expect(invocationKinds).not.toContain("list_models");

    const contextAccepted = await runCli([
      "review", "dispatch",
      "--requester", "codex",
      "--cwd", workspace,
      "--prompt", "dump-review-context",
    ], reviewEnv);
    const contextCompleted = await runCli(
      ["wait", contextAccepted.run_ref.run_id, "--timeout-ms", "10000"],
      reviewEnv,
    );
    expect(JSON.parse(contextCompleted.content[0].text)).toEqual({
      depth: "1",
    });
  }, 60000);

  it("runs a durable discussion from a detached CLI worker", async () => {
    const staleCommandDir = path.join(
      env.AGENT_HUB_DISCUSSION_DIR,
      ".cli-commands",
      "stale-command",
    );
    await fsp.mkdir(staleCommandDir, { recursive: true });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(staleCommandDir, staleAt, staleAt);
    const requestPath = path.join(root, "discussion.json");
    await fsp.writeFile(
      requestPath,
      JSON.stringify({
        kind: "new",
        objective: "validate CLI discussions",
        question: "Does the detached coordinator complete?",
        cwd: workspace,
        materials: [],
        host: { agent_id: "claude-code", metadata: {} },
        participants: [
          {
            participant_id: "reviewer-a",
            agent_id: "claude-code",
            role: "reliability reviewer",
            focus: "process lifecycle",
            metadata: {},
          },
          {
            participant_id: "reviewer-b",
            agent_id: "claude-code",
            role: "protocol reviewer",
            focus: "durability",
            metadata: {},
          },
        ],
        quorum: 2,
        budget_profile: "quick",
      }),
      { mode: 0o600 },
    );

    const accepted = await runCli(
      ["discussion", "dispatch", "--json-file", requestPath],
      env,
    );
    expect(accepted.status).toBe("accepted");
    await expect(fsp.access(staleCommandDir)).rejects.toThrow();

    const completed = await runCli(
      [
        "discussion",
        "wait",
        accepted.discussion_ref.discussion_id,
        "--timeout-ms",
        "30000",
      ],
      env,
      40000,
    );

    expect(completed.status).toBe("completed");
    expect(completed.protocol_integrity).toBe("complete");
    expect(completed.completion_quality).toBe("complete");
    expect(completed.budget_status).toMatchObject({
      profile: "quick",
      total_ms: 30 * 60 * 1000,
      repair_min_ms: 60 * 1000,
    });
    expect(completed.run_refs).toHaveLength(8);

    const listed = await runCli(
      [
        "discussion",
        "list",
        "--status",
        "completed",
        "--since",
        "7d",
        "--cwd",
        workspace,
        "--limit",
        "1",
      ],
      env,
    );
    expect(listed).toMatchObject({
      kind: "agent-discussion-list",
      total_matching: 1,
      has_more: false,
      discussions: [
        {
          discussion_ref: accepted.discussion_ref,
          status: "completed",
          completion_quality: "complete",
          budget_status: { profile: "quick" },
        },
      ],
    });

    const workerRecords = (await fsp.readFile(
      path.join(env.AGENT_HUB_DISCUSSION_DIR, ".workers.log"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(workerRecords.some((record) =>
      record.event === "discussion.accepted" &&
      record.discussion_id === accepted.discussion_ref.discussion_id
    )).toBe(true);
  }, 40000);

  it("resumes a discussion after its detached coordinator is killed", async () => {
    const requestPath = path.join(root, "recoverable-discussion.json");
    await writeDiscussionRequest(requestPath, workspace);
    const delayedEnv = { ...env, FAKE_CLAUDE_DELAY_MS: "300" };
    const accepted = await runCli(
      ["discussion", "dispatch", "--json-file", requestPath],
      delayedEnv,
    );
    const discussionId = accepted.discussion_ref.discussion_id;
    const leasePath = path.join(
      delayedEnv.AGENT_HUB_DISCUSSION_DIR,
      discussionId,
      "lease.json",
    );
    const lease = await waitForJson(leasePath);
    process.kill(lease.pid, "SIGKILL");
    await waitForProcessExit(lease.pid);

    const completed = await runCli(
      ["discussion", "wait", discussionId, "--timeout-ms", "30000"],
      delayedEnv,
      40000,
    );
    if (completed.status !== "completed") {
      const workerLog = await fsp
        .readFile(path.join(delayedEnv.AGENT_HUB_DISCUSSION_DIR, ".workers.log"), "utf8")
        .catch(() => "<missing worker log>");
      throw new Error(
        `Recovered discussion stayed ${completed.status}: ${JSON.stringify(completed.error)}\n${workerLog}`,
      );
    }
    expect(completed.status).toBe("completed");
    expect(completed.protocol_integrity).toBe("complete");
    expect(completed.run_refs).toHaveLength(8);
  }, 45000);
});

async function writeDiscussionRequest(target, workspace) {
  await fsp.writeFile(
    target,
    JSON.stringify({
      kind: "new",
      objective: "validate CLI discussion recovery",
      question: "Does the detached coordinator recover?",
      cwd: workspace,
      materials: [],
      host: { agent_id: "claude-code", metadata: {} },
      participants: [
        {
          participant_id: "reviewer-a",
          agent_id: "claude-code",
          role: "reliability reviewer",
          focus: "process lifecycle",
          metadata: {},
        },
        {
          participant_id: "reviewer-b",
          agent_id: "claude-code",
          role: "protocol reviewer",
          focus: "durability",
          metadata: {},
        },
      ],
      quorum: 2,
    }),
    { mode: 0o600 },
  );
}

async function waitForJson(target, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fsp.readFile(target, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for JSON file: ${target}`);
}

async function waitForWorkerLog(target, event, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const records = (await fsp.readFile(target, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (records.some((record) => record.event === event)) return records;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for worker log event ${event}: ${target}`);
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function runCli(args, childEnv, timeoutMs = 15000) {
  const { code, out, err } = await invokeCli(args, childEnv, timeoutMs);
  if (code !== 0) throw new Error(`CLI exited ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  return JSON.parse(out);
}

async function runCliFailure(args, childEnv, timeoutMs = 15000) {
  const { code, out, err } = await invokeCli(args, childEnv, timeoutMs);
  if (code === 0) throw new Error(`CLI unexpectedly succeeded\nstdout:\n${out}`);
  return JSON.parse(err);
}

async function invokeCli(args, childEnv, timeoutMs) {
  return invokeProcess(process.execPath, [CLI_PATH, ...args], childEnv, timeoutMs, "CLI");
}

async function runInternalDispatch(helper, payload, childEnv, timeoutMs = 15000) {
  const { code, out, err } = await invokeProcess(
    process.execPath,
    [helper],
    {
      ...childEnv,
      AGENT_HUB_TEST_INTERNAL_DISPATCH: JSON.stringify(payload),
    },
    timeoutMs,
    "internal dispatch",
  );
  if (code !== 0) {
    throw new Error(`Internal dispatch exited ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  }
  return JSON.parse(out);
}

async function invokeProcess(command, args, childEnv, timeoutMs, label) {
  const child = spawn(command, args, {
    cwd: path.dirname(path.dirname(CLI_PATH)),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  return { code, out, err };
}

async function writeFakeClaude(target) {
  await fsp.writeFile(
    target,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const recordInvocation = (kind) => {
  if (process.env.FAKE_CLAUDE_INVOCATION_LOG) {
    fs.appendFileSync(
      process.env.FAKE_CLAUDE_INVOCATION_LOG,
      JSON.stringify({ kind, args }) + "\\n",
    );
  }
};
if (args.includes("--version")) {
  recordInvocation("version");
  process.stdout.write("2.1.193 (Claude Code)\\n");
  process.exit(0);
}
const outputIndex = args.indexOf("--output-format");
const streamJson = outputIndex >= 0 && args[outputIndex + 1] === "stream-json";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0)));
  let controlRequest = null;
  try { controlRequest = JSON.parse(input.trim()); } catch {}
  if (controlRequest?.type === "control_request") {
    recordInvocation("list_models");
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: controlRequest.request_id,
        response: { models: [{ value: "haiku", resolvedModel: "fake-haiku" }] }
      }
    }) + "\\n");
    return;
  }
  recordInvocation("run");
  const sessionIndex = args.indexOf("--session-id");
  const resumeIndex = args.indexOf("--resume");
  const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : args[resumeIndex + 1];
  if (process.env.FAKE_CLAUDE_SKIP_TRANSCRIPT !== "1") {
    const transcriptDir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-agenthub-test");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.appendFileSync(
      path.join(transcriptDir, sessionId + ".jsonl"),
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n",
    );
  }
  const write = (value) => process.stdout.write(JSON.stringify(value) + (streamJson ? "\\n" : ""));
  if (streamJson) write({ type: "system", subtype: "init", session_id: sessionId });
  let result = "fake result: " + input;
  if (input.trim() === "dump-env") {
    result = JSON.stringify({ NS: process.env.NS ?? null, NS_UNDO: process.env.NS_UNDO ?? null, NS_REBIND: process.env.NS_REBIND ?? null, BORN_CWD: process.env.BORN_CWD ?? null, LEAK: process.env.LEAK ?? null });
  }
  if (input.trim() === "dump-env2") {
    result = JSON.stringify({ NS: process.env.NS ?? null, DA_FLAG: process.env.DA_FLAG ?? null, DB_FLAG: process.env.DB_FLAG ?? null, NS_REBIND: process.env.NS_REBIND ?? null, PATH: process.env.PATH ?? "" });
  }
  if (input.trim() === "dump-auth-env") {
    result = JSON.stringify({
      oauth_matches: process.env.CLAUDE_CODE_OAUTH_TOKEN === "unit-test-long-lived-oauth-token",
      oauth_file: process.env.AGENT_HUB_CLAUDE_OAUTH_TOKEN_FILE ?? null,
      anthropic_api_key: process.env.ANTHROPIC_API_KEY ?? null,
      anthropic_auth_token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
      anthropic_base_url: process.env.ANTHROPIC_BASE_URL ?? null,
      oauth_refresh_token: process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN ?? null,
      oauth_scopes: process.env.CLAUDE_CODE_OAUTH_SCOPES ?? null,
      bedrock: process.env.CLAUDE_CODE_USE_BEDROCK ?? null,
      vertex: process.env.CLAUDE_CODE_USE_VERTEX ?? null,
      foundry: process.env.CLAUDE_CODE_USE_FOUNDRY ?? null,
      internal_keys: Object.keys(process.env).filter((key) => key.startsWith("AGENT_HUB_INTERNAL_")),
    });
  }
  if (input.includes("AGENT_HUB_REVIEW_PROTOCOL_V1")) {
    if (input.includes("dump-review-context")) {
      result = JSON.stringify({
        depth: process.env.AGENT_HUB_REVIEW_DEPTH ?? null,
      });
    } else {
      const marker = "[ORIGINAL REVIEW REQUEST]\\n";
      result = "fake result: " + input.slice(input.lastIndexOf(marker) + marker.length).trim();
    }
  }
  if (input.includes("AGENT_HUB_DISCUSSION_PROTOCOL_V1")) {
    const marker = "[OUTPUT CONTRACT]\\n";
    const markerIndex = input.lastIndexOf(marker);
    result = input.slice(markerIndex + marker.length).trim();
  }
  if (streamJson) {
    write({ type: "assistant", message: { content: [{ type: "text", text: result }] }, session_id: sessionId });
    write({ type: "result", subtype: "success", result, session_id: sessionId, is_error: false });
  } else {
    write({ result, session_id: sessionId, is_error: false });
  }
});
`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

async function writeFakeCodex(target) {
  await fsp.writeFile(
    target,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.151.0\\n");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let result = "fake codex result: " + input;
  if (input.trim() === "dump-path-handoff") {
    result = JSON.stringify({
        path: process.env.PATH ?? "",
        path_after_zsh: process.env.PATH_AFTER_ZSH ?? null,
        tmp_after_zsh: process.env.TMP_AFTER_ZSH ?? null,
        tmpdir: process.env.TMPDIR ?? null,
        tmp: process.env.TMP ?? null,
        temp: process.env.TEMP ?? null,
        internal_path_prepend: process.env.AGENT_HUB_INTERNAL_PATH_PREPEND ?? null,
        internal_keys: Object.keys(process.env).filter((key) => key.startsWith("AGENT_HUB_INTERNAL_")),
      });
  }
  if (input.trim() === "dump-auth-env") {
    result = JSON.stringify({
      oauth_token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      oauth_file: process.env.AGENT_HUB_CLAUDE_OAUTH_TOKEN_FILE ?? null,
    });
  }
  const events = [
    { type: "thread.started", thread_id: "019f38ae-357d-7db3-89fb-670f88316240" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: result } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
});
`,
    { mode: 0o755 },
  );
  await fsp.chmod(target, 0o755);
}

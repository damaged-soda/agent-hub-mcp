import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_EVAL_PERMISSION_PROFILE_NAME,
  buildCodexCommand,
  codexEvalPermissionArgs,
  codexSessionRefFromEvent,
  createCodexSessionRef,
  interpretCodexExit,
  parseCodexModelCatalog,
  parseCodexStdout,
  parseCodexVersion,
  supportsCodexEvalVersion,
} from "../src/codex-adapter.js";

const THREAD_ID = "019f38ae-357d-7db3-89fb-670f88316240";

function successStdout(text = "hello\n") {
  return [
    JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
  ].join("\n");
}

describe("codex adapter", () => {
  it("detects the minimum Codex version required by the eval permission profile", () => {
    expect(parseCodexVersion("codex-cli 0.151.0")).toEqual([0, 151, 0]);
    expect(supportsCodexEvalVersion("codex-cli 0.150.9")).toBe(false);
    expect(supportsCodexEvalVersion("codex-cli 0.151.0")).toBe(true);
    expect(supportsCodexEvalVersion("unexpected")).toBe(false);
  });

  it("normalizes visible models and excludes hidden catalog entries", () => {
    const models = parseCodexModelCatalog(
      JSON.stringify({
        models: [
          {
            slug: "gpt-visible",
            display_name: "GPT Visible",
            description: "Selectable",
            visibility: "list",
            priority: 2,
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
            context_window: 200000,
            input_modalities: ["text", "image"],
            supports_reasoning_summaries: true,
          },
          { slug: "gpt-hidden", visibility: "hidden", priority: 1 },
        ],
      }),
    );

    expect(models).toEqual([
      {
        id: "gpt-visible",
        display_name: "GPT Visible",
        description: "Selectable",
        default_effort: "medium",
        priority: 2,
        context_window: 200000,
        supported_efforts: ["low", "high"],
        input_modalities: ["text", "image"],
        capabilities: ["reasoning_summaries"],
      },
    ]);
  });

  it("starts new sessions without a native session id", () => {
    const ref = createCodexSessionRef(null);
    expect(ref).toEqual({
      agent_id: "codex",
      native_session_id: null,
      resumed: false,
    });
  });

  it("marks continuations as resumed", () => {
    const ref = createCodexSessionRef({
      agent_id: "codex",
      native_session_id: THREAD_ID,
    });
    expect(ref).toEqual({
      agent_id: "codex",
      native_session_id: THREAD_ID,
      resumed: true,
    });
  });

  it("maps request metadata into codex exec argv", () => {
    const command = buildCodexCommand({
      request: {
        metadata: {
          codex: {
            model: "gpt-5.2-codex",
            effort: "high",
            sandbox: "read-only",
            add_dirs: ["./tmp/example"],
          },
        },
        resolved_metadata: {
          codex: {
            model: "gpt-5.2-codex",
            effort: "high",
            sandbox: "read-only",
            add_dirs: ["/tmp/example"],
          },
        },
      },
      effectiveCliSessionRef: createCodexSessionRef(null),
    });

    expect(command.argv).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.2-codex",
      "-c",
      'model_reasoning_effort="high"',
      "--sandbox",
      "read-only",
      "--add-dir",
      "/tmp/example",
      "-",
    ]);
    expect(command.output_format).toBe("jsonl");
  });

  it("builds an ephemeral workspace-only eval profile without legacy sandbox flags", () => {
    const command = buildCodexCommand({
      request: {
        prompt: "find it",
        metadata: { model: "gpt-visible", codex: { effort: "medium" } },
        resolved_metadata: {
          model: "gpt-visible",
          codex: { effort: "medium", add_dirs: [] },
        },
        execution_profile: {
          kind: "workspace-readonly/v1",
          scratch_path: "/private/tmp/agenthub-eval-case-test",
          output_schema_path: "/private/tmp/agenthub-eval-case-test/schema.json",
          agent_executable: "/opt/homebrew/bin/codex",
          runtime_read_paths: ["/opt/homebrew/bin/codex"],
          path_prepend: [],
        },
      },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: {},
    });

    expect(command.argv).toContain("--ephemeral");
    expect(command.argv).toContain("--ignore-user-config");
    expect(command.argv).toContain("--ignore-rules");
    expect(command.argv).toContain("--output-schema");
    expect(command.argv).not.toContain("--sandbox");
    expect(command.argv).not.toContain("--ask-for-approval");
    expect(command.argv).toContain('default_permissions="agenthub-eval"');
    expect(command.argv).toContain('approval_policy="never"');
    expect(command.argv).toContain('shell_environment_policy.inherit="core"');
    expect(command.argv).toContain("allow_login_shell=false");
    expect(command.argv.join("\n")).not.toContain("PYTHONNOUSERSITE");
    expect(command.argv.join("\n")).not.toContain("PYTHONDONTWRITEBYTECODE");
    expect(command.argv.join("\n")).not.toContain("PYTHONPATH");
    const profile = command.argv.find((item) => item.startsWith("permissions.agenthub-eval="));
    expect(profile).toContain('":minimal" = "read"');
    expect(profile).toContain('":workspace_roots" = { "." = "read"');
    expect(profile).toContain('".git" = "deny"');
    expect(profile).toContain('"/private/tmp/agenthub-eval-case-test" = "write"');
    expect(profile).toContain('"/opt/homebrew/bin/codex" = "read"');
    expect(profile).toContain("network = { enabled = false }");
    expect(command.env).toEqual({
      TMPDIR: "/private/tmp/agenthub-eval-case-test",
      TMP: "/private/tmp/agenthub-eval-case-test",
      TEMP: "/private/tmp/agenthub-eval-case-test",
    });
    expect(command.command).toBe("/opt/homebrew/bin/codex");
    expect(command.post_birth_env).toEqual(command.env);
    expect(command.path_prepend).toEqual([]);
  });

  it("builds a write-only-to-workspace patch eval profile", () => {
    const command = buildCodexCommand({
      request: {
        prompt: "change it",
        metadata: { model: "gpt-visible", codex: { effort: "medium" } },
        resolved_metadata: {
          model: "gpt-visible",
          codex: { effort: "medium", add_dirs: [] },
        },
        execution_profile: {
          kind: "workspace-write/v1",
          scratch_path: "/private/tmp/agenthub-eval-patch-test",
          output_schema_path: "/private/tmp/agenthub-eval-patch-test/schema.json",
          agent_executable: "/opt/homebrew/bin/codex",
          runtime_read_paths: ["/opt/homebrew/bin/codex"],
          path_prepend: ["/private/tmp/agenthub-eval-runtime-bin"],
        },
      },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: {},
    });

    expect(command.argv).toEqual([
      "/opt/homebrew/bin/codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-visible",
      "-c",
      'model_reasoning_effort="medium"',
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--disable",
      "memories",
      "--disable",
      "external_agent_memory_import",
      "--disable",
      "multi_agent",
      "--disable",
      "multi_agent_v2",
      "--output-schema",
      "/private/tmp/agenthub-eval-patch-test/schema.json",
      "-c",
      'default_permissions="agenthub-eval"',
      "-c",
      'approval_policy="never"',
      "-c",
      'shell_environment_policy.inherit="core"',
      "-c",
      "allow_login_shell=false",
      "-c",
      'shell_environment_policy.set.PYTHONNOUSERSITE="1"',
      "-c",
      'shell_environment_policy.set.PYTHONDONTWRITEBYTECODE="1"',
      "-c",
      'shell_environment_policy.set.PYTHONPATH=""',
      "-c",
      'shell_environment_policy.set.PYTHONHOME=""',
      "-c",
      'shell_environment_policy.set.PYTHONPLATLIBDIR=""',
      "-c",
      'shell_environment_policy.set.PYTHONEXECUTABLE=""',
      "-c",
      'shell_environment_policy.set.__PYVENV_LAUNCHER__=""',
      "-c",
      'permissions.agenthub-eval={ description = "Agent Hub workspace-only evaluation", filesystem = { ":minimal" = "read", ":workspace_roots" = { "." = "write", ".git" = "deny", ".git/**" = "deny" }, "/opt/homebrew/bin/codex" = "read", "/private/tmp/agenthub-eval-patch-test" = "write" }, network = { enabled = false } }',
      "-",
    ]);
    const profile = command.argv.find((item) => item.startsWith("permissions.agenthub-eval="));
    expect(profile).toContain('":workspace_roots" = { "." = "write"');
    expect(profile).toContain('".git" = "deny"');
    expect(profile).toContain("network = { enabled = false }");
    expect(command.argv).toContain("--ephemeral");
    expect(command.path_prepend).toEqual(["/private/tmp/agenthub-eval-runtime-bin"]);
    expect(command.env).not.toHaveProperty("PATH");
    expect(command.argv).toContain('shell_environment_policy.set.PYTHONNOUSERSITE="1"');
    expect(command.argv).toContain('shell_environment_policy.set.PYTHONDONTWRITEBYTECODE="1"');
    expect(command.argv).toContain('shell_environment_policy.set.PYTHONPATH=""');
    expect(command.argv).toContain('shell_environment_policy.set.PYTHONHOME=""');
    expect(command.argv).toContain('shell_environment_policy.set.PYTHONPLATLIBDIR=""');
    expect(command.argv).toContain('shell_environment_policy.set.PYTHONEXECUTABLE=""');
    expect(command.argv).toContain('shell_environment_policy.set.__PYVENV_LAUNCHER__=""');
    expect(command.argv).not.toContain(
      'shell_environment_policy.set.PATH="/private/tmp/agenthub-eval-runtime-bin"',
    );
  });

  it("builds workspace-write/v2 with deterministic toolchain environment settings", () => {
    const executionProfile = {
      kind: "workspace-write/v2",
      scratch_path: "/private/tmp/agenthub-eval-patch-v2-test",
      output_schema_path: "/private/tmp/agenthub-eval-patch-v2-test/schema.json",
      agent_executable: "/opt/toolchain/bin/codex",
      runtime_read_paths: ["/opt/toolchain", "/opt/codex-runtime"],
      path_prepend: ["/opt/toolchain/bin", "/opt/toolchain/extra-bin"],
    };
    const command = buildCodexCommand({
      request: {
        prompt: "change it",
        metadata: { model: "gpt-visible", codex: { effort: "medium" } },
        resolved_metadata: {
          model: "gpt-visible",
          codex: { effort: "medium", add_dirs: [] },
        },
        execution_profile: executionProfile,
      },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: {},
    });
    const permissionArgs = codexEvalPermissionArgs(executionProfile);

    expect(command.argv.slice(-(permissionArgs.length + 1), -1)).toEqual(permissionArgs);
    expect(command.path_prepend).toBeUndefined();
    expect(permissionArgs).toContain(
      `shell_environment_policy.set.PATH=${JSON.stringify(
        ["/opt/toolchain/bin", "/opt/toolchain/extra-bin"].join(path.delimiter),
      )}`,
    );
    expect(permissionArgs).toContain('shell_environment_policy.inherit="core"');
    expect(permissionArgs).toContain("allow_login_shell=false");
    for (const setting of [
      'shell_environment_policy.set.GIT_CONFIG_GLOBAL="/dev/null"',
      'shell_environment_policy.set.GIT_CONFIG_NOSYSTEM="1"',
      'shell_environment_policy.set.GIT_CONFIG_SYSTEM="/dev/null"',
      'shell_environment_policy.set.HOME="/private/tmp/agenthub-eval-patch-v2-test/task-home"',
      'shell_environment_policy.set.PYTHONDONTWRITEBYTECODE="1"',
      'shell_environment_policy.set.PYTHONNOUSERSITE="1"',
      'shell_environment_policy.set.TEMP="/private/tmp/agenthub-eval-patch-v2-test"',
      'shell_environment_policy.set.TMP="/private/tmp/agenthub-eval-patch-v2-test"',
      'shell_environment_policy.set.TMPDIR="/private/tmp/agenthub-eval-patch-v2-test"',
      'shell_environment_policy.set.ZDOTDIR="/private/tmp/agenthub-eval-patch-v2-test/task-home"',
    ]) {
      expect(permissionArgs).toContain(setting);
    }
    expect(permissionArgs).toContain(
      'shell_environment_policy.exclude=["BASH_ENV","ENV","GIT_CONFIG_GLOBAL","GIT_CONFIG_SYSTEM","GIT_DIR","GIT_EXEC_PATH","GIT_WORK_TREE","NODE_OPTIONS","NODE_PATH","PYTHONEXECUTABLE","PYTHONHOME","PYTHONPATH","PYTHONPLATLIBDIR","ZDOTDIR","__PYVENV_LAUNCHER__"]',
    );
    expect(permissionArgs.join("\n")).not.toContain(
      'shell_environment_policy.set.GIT_DIR=""',
    );
    expect(permissionArgs.join("\n")).not.toContain(
      'shell_environment_policy.set.GIT_WORK_TREE=""',
    );
    const profile = permissionArgs.find((item) =>
      item.startsWith("permissions.agenthub-eval="),
    );
    expect(profile).toContain('":workspace_roots" = { "." = "write"');
    expect(profile).toContain('".git" = "deny"');
    expect(profile).toContain('"/private/tmp/agenthub-eval-patch-v2-test" = "write"');
    expect(profile).toContain('"/opt/toolchain" = "read"');
    expect(profile).toContain('"/opt/codex-runtime" = "read"');
    expect(profile).toContain("network = { enabled = false }");
  });

  it("rejects unknown eval execution profiles", () => {
    const executionProfile = {
      kind: "workspace-write/v3",
      scratch_path: "/private/tmp/agenthub-eval-patch-test",
      output_schema_path: "/private/tmp/agenthub-eval-patch-test/schema.json",
      agent_executable: "/opt/homebrew/bin/codex",
      runtime_read_paths: ["/opt/homebrew/bin/codex"],
      path_prepend: [],
    };

    expect(() => codexEvalPermissionArgs(executionProfile)).toThrow(
      "Unsupported Codex execution profile: workspace-write/v3",
    );
    expect(() =>
      buildCodexCommand({
        request: {
          metadata: {},
          resolved_metadata: { codex: { add_dirs: [] } },
          execution_profile: executionProfile,
        },
        effectiveCliSessionRef: createCodexSessionRef(null),
        env: {},
      }),
    ).toThrow("Unsupported Codex execution profile: workspace-write/v3");
  });

  it("exposes reusable eval permission args without exec-only profile selection", () => {
    const args = codexEvalPermissionArgs({
      kind: "workspace-write/v1",
      scratch_path: "/private/tmp/agenthub-eval-patch-test",
      runtime_read_paths: ["/opt/homebrew/bin/codex", "/opt/homebrew/bin/python3"],
      path_prepend: ["/private/tmp/agenthub-eval-runtime-bin"],
    });

    expect(CODEX_EVAL_PERMISSION_PROFILE_NAME).toBe("agenthub-eval");
    expect(args).toContain('shell_environment_policy.inherit="core"');
    expect(args).toContain("allow_login_shell=false");
    expect(args).toContain('shell_environment_policy.set.PYTHONNOUSERSITE="1"');
    expect(args).toContain('shell_environment_policy.set.PYTHONDONTWRITEBYTECODE="1"');
    expect(args).toContain('shell_environment_policy.set.PYTHONPATH=""');
    expect(args).toContain('shell_environment_policy.set.PYTHONHOME=""');
    expect(args).toContain('shell_environment_policy.set.PYTHONPLATLIBDIR=""');
    expect(args).toContain('shell_environment_policy.set.PYTHONEXECUTABLE=""');
    expect(args).toContain('shell_environment_policy.set.__PYVENV_LAUNCHER__=""');
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("--output-schema");
    expect(args).not.toContain('default_permissions="agenthub-eval"');
    expect(args).not.toContain('approval_policy="never"');
    expect(args.join("\n")).not.toContain("agenthub-eval-runtime-bin");
    const profile = args.find((item) => item.startsWith("permissions.agenthub-eval="));
    expect(profile).toContain('":workspace_roots" = { "." = "write"');
    expect(profile).toContain('"/opt/homebrew/bin/python3" = "read"');
  });

  it("passes a pinned eval shebang interpreter to the birth launcher", () => {
    const command = buildCodexCommand({
      request: {
        metadata: {},
        resolved_metadata: { codex: { add_dirs: [] } },
        execution_profile: {
          kind: "workspace-readonly/v1",
          scratch_path: "/private/tmp/agenthub-eval-case-test",
          output_schema_path: "/private/tmp/agenthub-eval-case-test/schema.json",
          agent_executable: "/opt/codex/bin/codex.js",
          agent_interpreter: "/opt/node/bin/node",
          runtime_read_paths: ["/opt/codex", "/opt/node/bin/node"],
          path_prepend: [],
        },
      },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: {},
    });

    expect(command.command).toBe("/opt/codex/bin/codex.js");
    expect(command.path_interpreter).toBe("/opt/node/bin/node");
  });

  it("rejects eval profile permission overrides and session resume", () => {
    const executionProfile = {
      kind: "workspace-readonly/v1",
      scratch_path: "/private/tmp/agenthub-eval-case-test",
      output_schema_path: "/private/tmp/agenthub-eval-case-test/schema.json",
      agent_executable: "/opt/homebrew/bin/codex",
      runtime_read_paths: ["/opt/homebrew/bin/codex"],
      path_prepend: [],
    };
    expect(() => buildCodexCommand({
      request: {
        metadata: { permission: "full" },
        resolved_metadata: { permission: "full", codex: { add_dirs: [] } },
        execution_profile: executionProfile,
      },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: {},
    })).toThrow(/owns sandbox/);
    expect(() => buildCodexCommand({
      request: {
        metadata: {},
        resolved_metadata: { codex: { add_dirs: [] } },
        execution_profile: executionProfile,
      },
      effectiveCliSessionRef: createCodexSessionRef({
        agent_id: "codex",
        native_session_id: THREAD_ID,
      }),
      env: {},
    })).toThrow(/cannot resume/);
  });

  it("defaults to auto permission: workspace-write with network access", () => {
    const command = buildCodexCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: {},
    });

    expect(command.argv).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-",
    ]);
  });

  it("maps unified permission read-only and full onto sandbox modes", () => {
    const readOnly = buildCodexCommand({
      request: { metadata: { permission: "read-only" } },
      effectiveCliSessionRef: createCodexSessionRef(null),
    });
    expect(readOnly.argv).toContain("read-only");
    expect(readOnly.argv).not.toContain("sandbox_workspace_write.network_access=true");

    const full = buildCodexCommand({
      request: { metadata: { permission: "full" } },
      effectiveCliSessionRef: createCodexSessionRef(null),
    });
    expect(full.argv).toContain("danger-full-access");
    expect(full.argv).not.toContain("sandbox_workspace_write.network_access=true");
  });

  it("lets native metadata.codex.sandbox opt out of the auto network override", () => {
    const command = buildCodexCommand({
      request: { metadata: { codex: { sandbox: "workspace-write" } } },
      effectiveCliSessionRef: createCodexSessionRef(null),
    });
    expect(command.argv).toContain("workspace-write");
    expect(command.argv).not.toContain("sandbox_workspace_write.network_access=true");
  });

  it("maps unified model when the codex namespace omits it", () => {
    const command = buildCodexCommand({
      request: { metadata: { model: "gpt-5.2-codex" } },
      effectiveCliSessionRef: createCodexSessionRef(null),
    });
    expect(command.argv).toContain("gpt-5.2-codex");

    const overridden = buildCodexCommand({
      request: {
        metadata: { model: "gpt-5.2-codex", codex: { model: "o4-mini" } },
      },
      effectiveCliSessionRef: createCodexSessionRef(null),
    });
    const modelIndex = overridden.argv.indexOf("--model");
    expect(overridden.argv[modelIndex + 1]).toBe("o4-mini");
  });

  it("falls back to AGENT_HUB_CODEX_EFFORT when metadata omits the effort", () => {
    const command = buildCodexCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: { AGENT_HUB_CODEX_EFFORT: "xhigh" },
    });
    expect(command.argv).toContain('model_reasoning_effort="xhigh"');

    const overridden = buildCodexCommand({
      request: { metadata: { codex: { effort: "minimal" } } },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: { AGENT_HUB_CODEX_EFFORT: "xhigh" },
    });
    expect(overridden.argv).toContain('model_reasoning_effort="minimal"');
    expect(overridden.argv).not.toContain('model_reasoning_effort="xhigh"');
  });

  it("rejects unknown unified permissions", () => {
    expect(() =>
      buildCodexCommand({
        request: { metadata: { permission: "yolo" } },
        effectiveCliSessionRef: createCodexSessionRef(null),
      }),
    ).toThrow(/metadata.permission must be one of/);
  });

  it("rejects resume session ids that are not thread UUIDs", () => {
    expect(() =>
      createCodexSessionRef({ agent_id: "codex", native_session_id: "--last" }),
    ).toThrow(/must be a Codex thread UUID/);

    expect(() =>
      buildCodexCommand({
        request: { metadata: {} },
        effectiveCliSessionRef: {
          agent_id: "codex",
          native_session_id: "--last",
          resumed: true,
        },
      }),
    ).toThrow(/must be a Codex thread UUID/);
  });

  it("rejects unknown sandbox modes", () => {
    expect(() =>
      buildCodexCommand({
        request: { metadata: { codex: { sandbox: "yolo" } } },
        effectiveCliSessionRef: createCodexSessionRef(null),
      }),
    ).toThrow(/metadata.codex.sandbox must be one of/);
  });

  it("falls back to AGENT_HUB_CODEX_MODEL when metadata omits the model", () => {
    const command = buildCodexCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: { AGENT_HUB_CODEX_MODEL: "gpt-5.2-codex" },
    });

    const modelIndex = command.argv.indexOf("--model");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(command.argv[modelIndex + 1]).toBe("gpt-5.2-codex");
  });

  it("prefers metadata.codex.model over AGENT_HUB_CODEX_MODEL", () => {
    const command = buildCodexCommand({
      request: { metadata: { codex: { model: "o4-mini" } } },
      effectiveCliSessionRef: createCodexSessionRef(null),
      env: { AGENT_HUB_CODEX_MODEL: "gpt-5.2-codex" },
    });

    const modelIndex = command.argv.indexOf("--model");
    expect(command.argv[modelIndex + 1]).toBe("o4-mini");
  });

  it("requires resolved_metadata when add_dirs are provided", () => {
    expect(() =>
      buildCodexCommand({
        request: { metadata: { codex: { add_dirs: ["/tmp/example"] } } },
        effectiveCliSessionRef: createCodexSessionRef(null),
      }),
    ).toThrow(/resolved_metadata is required/);
  });

  it("maps continuations onto codex exec resume with config overrides", () => {
    const command = buildCodexCommand({
      request: {
        metadata: { codex: { sandbox: "workspace-write", add_dirs: ["/tmp/example"] } },
        resolved_metadata: {
          codex: { sandbox: "workspace-write", add_dirs: ["/tmp/example"] },
        },
      },
      effectiveCliSessionRef: createCodexSessionRef({
        agent_id: "codex",
        native_session_id: THREAD_ID,
      }),
      env: {},
    });

    expect(command.argv).toEqual([
      "codex",
      "exec",
      "resume",
      THREAD_ID,
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'sandbox_workspace_write.writable_roots=["/tmp/example"]',
      "-",
    ]);
    expect(command.argv).not.toContain("--sandbox");
    expect(command.argv).not.toContain("--add-dir");
  });

  it("keeps the auto network override on resume", () => {
    const command = buildCodexCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: createCodexSessionRef({
        agent_id: "codex",
        native_session_id: THREAD_ID,
      }),
      env: {},
    });

    expect(command.argv).toContain('sandbox_mode="workspace-write"');
    expect(command.argv).toContain("sandbox_workspace_write.network_access=true");
  });

  it("parses the event stream into result text and session ref", () => {
    const parsed = parseCodexStdout(successStdout());
    expect(parsed.resultText).toBe("hello");
    expect(parsed.cliSessionRef).toEqual({
      agent_id: "codex",
      native_session_id: THREAD_ID,
    });
    expect(parsed.turnCompletedEvent).toBeTruthy();
  });

  it("interprets a clean exit as completed", () => {
    const outcome = interpretCodexExit({
      code: 0,
      signal: null,
      stdout: successStdout("done\n"),
      stderr: "",
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.resultText).toBe("done");
    expect(outcome.resultJson.item.type).toBe("agent_message");
    expect(outcome.cliSessionRef.native_session_id).toBe(THREAD_ID);
  });

  it("interprets turn.failed as agent_error with session ref", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: "boom" }),
      JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
    ].join("\n");
    const outcome = interpretCodexExit({ code: 1, signal: null, stdout, stderr: "" });

    expect(outcome.status).toBe("failed");
    expect(outcome.error.code).toBe("agent_error");
    expect(outcome.error.message).toBe("boom");
    expect(outcome.error.result_text).toBe("boom");
    expect(outcome.error.cli_session_ref.native_session_id).toBe(THREAD_ID);
  });

  it("treats a retried error before turn.completed as success", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: "stream disconnected, retrying" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "recovered" },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");
    const outcome = interpretCodexExit({ code: 0, signal: null, stdout, stderr: "" });

    expect(outcome.status).toBe("completed");
    expect(outcome.resultText).toBe("recovered");
  });

  it("maps a nonzero exit without turn.failed to cli_exit_nonzero", () => {
    const outcome = interpretCodexExit({
      code: 2,
      signal: null,
      stdout: "",
      stderr: "usage: codex exec\n",
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error.code).toBe("cli_exit_nonzero");
    expect(outcome.error.message).toContain("exited with code 2");
    expect(outcome.error.stderr_tail).toContain("usage: codex exec");
  });

  it("fails parse when the stream has no agent message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");
    const outcome = interpretCodexExit({ code: 0, signal: null, stdout, stderr: "" });

    expect(outcome.status).toBe("failed");
    expect(outcome.error.code).toBe("stdout_parse_failed");
    expect(outcome.error.message).toMatch(/agent_message/);
  });

  it("extracts an early session ref from thread.started only", () => {
    expect(
      codexSessionRefFromEvent({ type: "thread.started", thread_id: THREAD_ID }),
    ).toEqual({ agent_id: "codex", native_session_id: THREAD_ID });
    expect(codexSessionRefFromEvent({ type: "turn.started" })).toBeNull();
    expect(codexSessionRefFromEvent({ type: "thread.started", thread_id: " " })).toBeNull();
    expect(
      codexSessionRefFromEvent({ type: "thread.started", thread_id: "0199abc" }),
    ).toBeNull();
  });
});

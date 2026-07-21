import { describe, expect, it } from "vitest";
import {
  buildCodexCommand,
  codexSessionRefFromEvent,
  createCodexSessionRef,
  interpretCodexExit,
  parseCodexModelCatalog,
  parseCodexStdout,
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

  it("defaults to auto permission: workspace-write with network access", () => {
    const command = buildCodexCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: createCodexSessionRef(null),
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
  });
});

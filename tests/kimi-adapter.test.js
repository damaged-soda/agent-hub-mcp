import { describe, expect, it } from "vitest";
import {
  buildKimiCommand,
  createKimiSessionRef,
  interpretKimiExit,
  parseKimiStdout,
} from "../src/kimi-adapter.js";

const SESSION_ID = "session_437f4ac7-19f4-472b-be3c-a87be0f41419";

function successStdout(text = "hello") {
  return [
    JSON.stringify({ role: "assistant", content: text }),
    JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: SESSION_ID,
      command: `kimi -r ${SESSION_ID}`,
      content: `To resume this session: kimi -r ${SESSION_ID}`,
    }),
  ].join("\n");
}

describe("kimi adapter", () => {
  it("starts new sessions without a native session id", () => {
    const ref = createKimiSessionRef(null);
    expect(ref).toEqual({
      agent_id: "kimi-code",
      native_session_id: null,
      resumed: false,
    });
  });

  it("marks continuations as resumed", () => {
    const ref = createKimiSessionRef({
      agent_id: "kimi-code",
      native_session_id: SESSION_ID,
    });
    expect(ref).toEqual({
      agent_id: "kimi-code",
      native_session_id: SESSION_ID,
      resumed: true,
    });
  });

  it("maps request metadata into kimi argv", () => {
    const command = buildKimiCommand({
      request: {
        prompt: "review this",
        metadata: {
          "kimi-code": {
            model: "k2",
            effort: "high",
            add_dirs: ["./tmp/example"],
          },
        },
        resolved_metadata: {
          "kimi-code": {
            model: "k2",
            effort: "high",
            add_dirs: ["/tmp/example"],
          },
        },
      },
      effectiveCliSessionRef: createKimiSessionRef(null),
    });

    expect(command.argv).toEqual([
      "kimi",
      "-p",
      "review this",
      "--output-format",
      "stream-json",
      "-m",
      "k2",
      "--add-dir",
      "/tmp/example",
    ]);
    expect(command.output_format).toBe("stream-json");
    expect(command.env).toEqual({ KIMI_MODEL_THINKING_EFFORT: "high" });
  });

  it("adds no permission flags: kimi -p always runs with built-in auto approval", () => {
    const command = buildKimiCommand({
      request: { prompt: "review this", metadata: {} },
      effectiveCliSessionRef: createKimiSessionRef(null),
    });

    expect(command.argv).toEqual([
      "kimi",
      "-p",
      "review this",
      "--output-format",
      "stream-json",
    ]);
    expect(command.argv).not.toContain("--plan");
    expect(command.argv).not.toContain("--auto");
    expect(command.argv).not.toContain("--yolo");
    expect(command.env).toBeUndefined();
  });

  it("rejects unified permissions other than auto", () => {
    for (const permission of ["read-only", "full"]) {
      expect(() =>
        buildKimiCommand({
          request: { prompt: "review this", metadata: { permission } },
          effectiveCliSessionRef: createKimiSessionRef(null),
        }),
      ).toThrow(/not supported by kimi -p/);
    }
  });

  it("rejects unknown unified permissions", () => {
    expect(() =>
      buildKimiCommand({
        request: { prompt: "review this", metadata: { permission: "yolo" } },
        effectiveCliSessionRef: createKimiSessionRef(null),
      }),
    ).toThrow(/metadata.permission must be one of/);
  });

  it("maps unified model when the kimi-code namespace omits it", () => {
    const command = buildKimiCommand({
      request: { prompt: "review this", metadata: { model: "k2" } },
      effectiveCliSessionRef: createKimiSessionRef(null),
    });
    expect(command.argv).toContain("k2");

    const overridden = buildKimiCommand({
      request: {
        prompt: "review this",
        metadata: { model: "k2", "kimi-code": { model: "k1.5" } },
      },
      effectiveCliSessionRef: createKimiSessionRef(null),
    });
    const modelIndex = overridden.argv.indexOf("-m");
    expect(overridden.argv[modelIndex + 1]).toBe("k1.5");
  });

  it("falls back to AGENT_HUB_KIMI_MODEL when metadata omits the model", () => {
    const command = buildKimiCommand({
      request: { prompt: "review this", metadata: {} },
      effectiveCliSessionRef: createKimiSessionRef(null),
      env: { AGENT_HUB_KIMI_MODEL: "k2" },
    });

    const modelIndex = command.argv.indexOf("-m");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(command.argv[modelIndex + 1]).toBe("k2");
  });

  it("prefers metadata.kimi-code.model over AGENT_HUB_KIMI_MODEL", () => {
    const command = buildKimiCommand({
      request: { prompt: "review this", metadata: { "kimi-code": { model: "k1.5" } } },
      effectiveCliSessionRef: createKimiSessionRef(null),
      env: { AGENT_HUB_KIMI_MODEL: "k2" },
    });

    const modelIndex = command.argv.indexOf("-m");
    expect(command.argv[modelIndex + 1]).toBe("k1.5");
  });

  it("falls back to AGENT_HUB_KIMI_EFFORT when metadata omits the effort", () => {
    const command = buildKimiCommand({
      request: { prompt: "review this", metadata: {} },
      effectiveCliSessionRef: createKimiSessionRef(null),
      env: { AGENT_HUB_KIMI_EFFORT: "xhigh" },
    });
    expect(command.env).toEqual({ KIMI_MODEL_THINKING_EFFORT: "xhigh" });

    const overridden = buildKimiCommand({
      request: { prompt: "review this", metadata: { "kimi-code": { effort: "low" } } },
      effectiveCliSessionRef: createKimiSessionRef(null),
      env: { AGENT_HUB_KIMI_EFFORT: "xhigh" },
    });
    expect(overridden.env).toEqual({ KIMI_MODEL_THINKING_EFFORT: "low" });
  });

  it("passes effort values through without enumerating them", () => {
    const command = buildKimiCommand({
      request: { prompt: "review this", metadata: { "kimi-code": { effort: "ultra" } } },
      effectiveCliSessionRef: createKimiSessionRef(null),
    });
    expect(command.env).toEqual({ KIMI_MODEL_THINKING_EFFORT: "ultra" });
  });

  it("rejects resume session ids that are not kimi session ids", () => {
    expect(() =>
      createKimiSessionRef({ agent_id: "kimi-code", native_session_id: "--help" }),
    ).toThrow(/must be a Kimi session id/);

    expect(() =>
      buildKimiCommand({
        request: { prompt: "review this", metadata: {} },
        effectiveCliSessionRef: {
          agent_id: "kimi-code",
          native_session_id: "--help",
          resumed: true,
        },
      }),
    ).toThrow(/must be a Kimi session id/);
  });

  it("requires resolved_metadata when add_dirs are provided", () => {
    expect(() =>
      buildKimiCommand({
        request: {
          prompt: "review this",
          metadata: { "kimi-code": { add_dirs: ["/tmp/example"] } },
        },
        effectiveCliSessionRef: createKimiSessionRef(null),
      }),
    ).toThrow(/resolved_metadata is required/);
  });

  it("requires a non-empty prompt", () => {
    expect(() =>
      buildKimiCommand({
        request: { metadata: {} },
        effectiveCliSessionRef: createKimiSessionRef(null),
      }),
    ).toThrow(/request.prompt must be a non-empty string/);
  });

  it("maps continuations onto kimi --session", () => {
    const command = buildKimiCommand({
      request: { prompt: "continue", metadata: {} },
      effectiveCliSessionRef: createKimiSessionRef({
        agent_id: "kimi-code",
        native_session_id: SESSION_ID,
      }),
    });

    expect(command.argv).toEqual([
      "kimi",
      "--session",
      SESSION_ID,
      "-p",
      "continue",
      "--output-format",
      "stream-json",
    ]);
  });

  it("parses the event stream into result text and session ref", () => {
    const parsed = parseKimiStdout(successStdout());
    expect(parsed.resultText).toBe("hello");
    expect(parsed.cliSessionRef).toEqual({
      agent_id: "kimi-code",
      native_session_id: SESSION_ID,
    });
  });

  it("uses the last assistant message as the result", () => {
    const stdout = [
      JSON.stringify({
        role: "assistant",
        tool_calls: [
          { type: "function", id: "tool_1", function: { name: "Bash", arguments: "{}" } },
        ],
      }),
      JSON.stringify({ role: "tool", tool_call_id: "tool_1", content: "tool output" }),
      JSON.stringify({ role: "assistant", content: "final answer" }),
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: SESSION_ID,
        command: `kimi -r ${SESSION_ID}`,
        content: `To resume this session: kimi -r ${SESSION_ID}`,
      }),
    ].join("\n");
    const parsed = parseKimiStdout(stdout);
    expect(parsed.resultText).toBe("final answer");
    expect(parsed.cliSessionRef.native_session_id).toBe(SESSION_ID);
  });

  it("interprets a clean exit as completed", () => {
    const outcome = interpretKimiExit({
      code: 0,
      signal: null,
      stdout: successStdout("done"),
      stderr: "",
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.resultText).toBe("done");
    expect(outcome.cliSessionRef.native_session_id).toBe(SESSION_ID);
  });

  it("maps failed-to-run-prompt stderr onto agent_error", () => {
    const outcome = interpretKimiExit({
      code: 1,
      signal: null,
      stdout: "",
      stderr:
        'error: failed to run prompt: config.invalid: Model "no-such" is not configured in config.toml.\nSee log: /tmp/x/kimi-code.log\n',
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error.code).toBe("agent_error");
    expect(outcome.error.message).toContain('Model "no-such" is not configured');
    expect(outcome.error.message).not.toContain("See log");
    expect(outcome.error.result_text).toBe(outcome.error.message);
  });

  it("maps a nonzero exit without a prompt failure to cli_exit_nonzero", () => {
    const outcome = interpretKimiExit({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "error: Cannot combine --prompt with --plan.\n",
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error.code).toBe("cli_exit_nonzero");
    expect(outcome.error.message).toContain("exited with code 1");
    expect(outcome.error.stderr_tail).toContain("Cannot combine");
  });

  it("fails parse when the stream has no assistant message", () => {
    const stdout = JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: SESSION_ID,
      command: `kimi -r ${SESSION_ID}`,
      content: `To resume this session: kimi -r ${SESSION_ID}`,
    });
    const outcome = interpretKimiExit({ code: 0, signal: null, stdout, stderr: "" });
    expect(outcome.status).toBe("failed");
    expect(outcome.error.code).toBe("stdout_parse_failed");
    expect(outcome.error.message).toMatch(/assistant message/);
  });

  it("fails parse when the stream has no session id", () => {
    const outcome = interpretKimiExit({
      code: 0,
      signal: null,
      stdout: JSON.stringify({ role: "assistant", content: "done" }),
      stderr: "",
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error.code).toBe("stdout_parse_failed");
    expect(outcome.error.message).toMatch(/session_id/);
  });
});

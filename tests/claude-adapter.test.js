import { describe, expect, it } from "vitest";
import {
  buildClaudeCommand,
  interpretClaudeExit,
  parseClaudeJson,
  parseClaudeOutput,
  parseClaudeStdout,
} from "../src/claude-adapter.js";

describe("claude adapter", () => {
  it("maps request metadata and new sessions into Claude argv", () => {
    const command = buildClaudeCommand({
      request: {
        metadata: {
          claude: {
            model: "sonnet",
            effort: "medium",
            agent: "reviewer",
            permission_mode: "plan",
            add_dirs: ["./tmp/example"],
          },
        },
        resolved_metadata: {
          claude: {
            model: "sonnet",
            effort: "medium",
            agent: "reviewer",
            permission_mode: "plan",
            add_dirs: ["/tmp/example"],
          },
        },
      },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
    });

    expect(command.argv).toEqual([
      "claude",
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "550e8400-e29b-41d4-a716-446655440000",
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--agent",
      "reviewer",
      "--permission-mode",
      "plan",
      "--add-dir",
      "/tmp/example",
    ]);
  });

  it("falls back to AGENT_HUB_CLAUDE_MODEL when metadata omits the model", () => {
    const command = buildClaudeCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
      env: { AGENT_HUB_CLAUDE_MODEL: "claude-opus-4-8" },
    });

    const modelIndex = command.argv.indexOf("--model");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(command.argv[modelIndex + 1]).toBe("claude-opus-4-8");
  });

  it("prefers metadata.claude.model over AGENT_HUB_CLAUDE_MODEL", () => {
    const command = buildClaudeCommand({
      request: { metadata: { claude: { model: "sonnet" } } },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
      env: { AGENT_HUB_CLAUDE_MODEL: "claude-opus-4-8" },
    });

    const modelIndex = command.argv.indexOf("--model");
    expect(command.argv[modelIndex + 1]).toBe("sonnet");
  });

  it("falls back to AGENT_HUB_CLAUDE_EFFORT when metadata omits the effort", () => {
    const command = buildClaudeCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
      env: { AGENT_HUB_CLAUDE_EFFORT: "high" },
    });

    const effortIndex = command.argv.indexOf("--effort");
    expect(effortIndex).toBeGreaterThan(-1);
    expect(command.argv[effortIndex + 1]).toBe("high");

    const overridden = buildClaudeCommand({
      request: { metadata: { claude: { effort: "low" } } },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
      env: { AGENT_HUB_CLAUDE_EFFORT: "high" },
    });
    const overriddenIndex = overridden.argv.indexOf("--effort");
    expect(overridden.argv[overriddenIndex + 1]).toBe("low");
  });

  it("ignores a blank AGENT_HUB_CLAUDE_MODEL", () => {
    const command = buildClaudeCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
      env: { AGENT_HUB_CLAUDE_MODEL: "   " },
    });

    expect(command.argv).not.toContain("--model");
  });

  it("maps unified metadata onto Claude flags with namespace precedence", () => {
    const unified = buildClaudeCommand({
      request: {
        metadata: { model: "sonnet", permission: "read-only" },
      },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
    });
    expect(unified.argv).toContain("sonnet");
    const modeIndex = unified.argv.indexOf("--permission-mode");
    expect(unified.argv[modeIndex + 1]).toBe("plan");

    const full = buildClaudeCommand({
      request: { metadata: { permission: "full" } },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
    });
    expect(full.argv).toContain("bypassPermissions");

    const overridden = buildClaudeCommand({
      request: {
        metadata: { permission: "read-only", claude: { permission_mode: "acceptEdits" } },
      },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
    });
    expect(overridden.argv).toContain("acceptEdits");
    expect(overridden.argv).not.toContain("plan");
  });

  it("maps continuation sessions into --resume", () => {
    const command = buildClaudeCommand({
      request: { metadata: {} },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: true,
      },
    });

    expect(command.argv).toContain("--resume");
    expect(command.argv).not.toContain("--session-id");
    expect(command.argv).toContain("--permission-mode");
    expect(command.argv).toContain("auto");
  });

  it("parses successful Claude JSON into result text and session ref", () => {
    const parsed = parseClaudeStdout(
      JSON.stringify({
        result: "hello\n",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        is_error: false,
      }),
    );

    expect(parsed.resultText).toBe("hello");
    expect(parsed.cliSessionRef.native_session_id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("parses result fields without deciding runner failure state", () => {
    const parsed = parseClaudeJson(
      JSON.stringify({
        result: "error",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        is_error: true,
      }),
    );

    expect(parsed.is_error).toBe(true);
    expect(parseClaudeStdout(JSON.stringify(parsed)).resultText).toBe("error");
  });

  it("parses stream-json output into result text and session ref", () => {
    const parsed = parseClaudeOutput(
      [
        "non-json startup line",
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "550e8400-e29b-41d4-a716-446655440000",
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "hello\n" }] },
          session_id: "550e8400-e29b-41d4-a716-446655440000",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "hello\n",
          session_id: "550e8400-e29b-41d4-a716-446655440000",
        }),
      ].join("\n"),
      "stream-json",
    );

    expect(parsed.resultText).toBe("hello");
    expect(parsed.cliSessionRef.native_session_id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(parsed.isError).toBe(false);
  });

  it("preserves a structured Claude error when the CLI exits nonzero", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const message = "You've hit your session limit · resets 7am (Asia/Singapore)";
    const outcome = interpretClaudeExit({
      code: 1,
      signal: null,
      stderr: "",
      outputFormat: "stream-json",
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 429,
          terminal_reason: "api_error",
          result: message,
          session_id: sessionId,
        }),
      ].join("\n"),
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "agent_error",
        message,
        result_text: message,
        exit_code: 1,
        signal: null,
        api_error_status: 429,
        terminal_reason: "api_error",
        cli_session_ref: {
          agent_id: "claude-code",
          native_session_id: sessionId,
        },
      },
    });
  });

  it("falls back to cli_exit_nonzero when nonzero stdout has no structured result", () => {
    const outcome = interpretClaudeExit({
      code: 1,
      signal: null,
      stdout: "not a Claude result",
      stderr: "native failure",
      outputFormat: "stream-json",
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "cli_exit_nonzero",
        message: "Claude exited with code 1",
        stderr_tail: "native failure",
      },
    });
  });

  it("maps legacy json output without stream flags", () => {
    const command = buildClaudeCommand({
      request: {
        metadata: {
          claude: {
            output_format: "json",
          },
        },
      },
      effectiveCliSessionRef: {
        agent_id: "claude-code",
        native_session_id: "550e8400-e29b-41d4-a716-446655440000",
        resumed: false,
      },
    });

    expect(command.output_format).toBe("json");
    expect(command.argv).toContain("json");
    expect(command.argv).not.toContain("--verbose");

    const parsed = parseClaudeOutput(
      JSON.stringify({
        result: "legacy",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        is_error: false,
      }),
      "json",
    );
    expect(parsed.resultText).toBe("legacy");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildClaudeCommand,
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

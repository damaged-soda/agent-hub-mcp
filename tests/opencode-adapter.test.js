import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOpenCodeCommand,
  createOpenCodeSessionRef,
  getOpenCodeModelCatalog,
  interpretOpenCodeExit,
  missingOpenCodeRunFlags,
  openCodeSessionRefFromEvent,
  parseOpenCodeModelCatalog,
  parseOpenCodeStdout,
  parseOpenCodeVersion,
} from "../src/opencode-adapter.js";

const SESSION_ID = "ses_fb85c573bffepZtC0aqhSb265B";

function successStdout(text = "final answer") {
  return [
    JSON.stringify({
      type: "text",
      sessionID: SESSION_ID,
      part: { type: "text", text: "intermediate" },
    }),
    JSON.stringify({
      type: "tool_use",
      sessionID: SESSION_ID,
      part: { type: "tool", tool: "read", state: { status: "completed" } },
    }),
    JSON.stringify({
      type: "text",
      sessionID: SESSION_ID,
      part: { type: "text", text },
    }),
    JSON.stringify({ type: "step_finish", sessionID: SESSION_ID }),
  ].join("\n");
}

describe("opencode version probe", () => {
  it("accepts a bare semver and rejects branded output", () => {
    expect(parseOpenCodeVersion("1.18.25\n", "")).toEqual([1, 18, 25]);
    expect(parseOpenCodeVersion("opencode 1.18.25\n", "")).toBeNull();
  });

  it("probes the required non-interactive run flags", () => {
    const complete = "--format --session --model --variant --auto";
    expect(missingOpenCodeRunFlags(complete)).toEqual([]);
    expect(missingOpenCodeRunFlags("--format --session --model")).toEqual([
      "--variant",
      "--auto",
    ]);
  });
});

describe("opencode model catalog", () => {
  it("normalizes unique provider/model lines and strips ANSI", () => {
    expect(
      parseOpenCodeModelCatalog([
        "zai-coding-plan/glm-5.3-flash",
        "\u001b[32mzai-coding-plan/glm-5.3\u001b[0m",
        "zai-coding-plan/glm-5.3-flash",
        "not-a-model",
        "/Users/example/.config/opencode",
        "warning: see https://example.invalid/models",
        "",
      ].join("\n")),
    ).toEqual([
      {
        id: "zai-coding-plan/glm-5.3-flash",
        display_name: "zai-coding-plan/glm-5.3-flash",
      },
      {
        id: "zai-coding-plan/glm-5.3",
        display_name: "zai-coding-plan/glm-5.3",
      },
    ]);
  });

  it("preserves bounded stderr when model discovery fails", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agenthub-opencode-catalog-"));
    const bin = path.join(root, "bin");
    await fsp.mkdir(bin);
    await fsp.writeFile(
      path.join(bin, "opencode"),
      "#!/bin/sh\nprintf '%s\\n' 'Unknown: FileSystem.open (/sandbox/opencode.log)' >&2\nexit 1\n",
      { mode: 0o755 },
    );

    try {
      await expect(getOpenCodeModelCatalog({
        cwd: root,
        env: { HOME: root, PATH: bin },
      })).resolves.toEqual({
        models: [],
        model_discovery: {
          status: "unavailable",
          source: "opencode-models",
          reason: "Unknown: FileSystem.open (/sandbox/opencode.log)",
        },
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("opencode adapter", () => {
  it("starts new sessions without a native session id", () => {
    expect(createOpenCodeSessionRef(null)).toEqual({
      agent_id: "opencode",
      native_session_id: null,
      resumed: false,
    });
  });

  it("validates and resumes OpenCode session ids", () => {
    const ref = createOpenCodeSessionRef({
      agent_id: "opencode",
      native_session_id: SESSION_ID,
    });
    expect(ref).toEqual({
      agent_id: "opencode",
      native_session_id: SESSION_ID,
      resumed: true,
    });
    expect(() =>
      createOpenCodeSessionRef({ agent_id: "opencode", native_session_id: "--help" }),
    ).toThrow(/OpenCode session id/);
  });

  it("maps model, effort, agent, auto permission, and session onto argv", () => {
    const command = buildOpenCodeCommand({
      request: {
        prompt: "--review this",
        metadata: {},
        resolved_metadata: {
          opencode: {
            model: "zai-coding-plan/glm-5.3-flash",
            effort: "max",
            agent: "build",
            add_dirs: [],
          },
        },
      },
      effectiveCliSessionRef: createOpenCodeSessionRef({
        agent_id: "opencode",
        native_session_id: SESSION_ID,
      }),
      env: {},
    });

    expect(command.argv).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--session",
      SESSION_ID,
      "--model",
      "zai-coding-plan/glm-5.3-flash",
      "--variant",
      "max",
      "--agent",
      "build",
      "--auto",
    ]);
    expect(command.argv).not.toContain("--review this");
    expect(command.output_format).toBe("jsonl");
  });

  it("uses unified model and environment defaults", () => {
    const unified = buildOpenCodeCommand({
      request: { prompt: "review", metadata: { model: "provider/unified" } },
      effectiveCliSessionRef: createOpenCodeSessionRef(null),
      env: { AGENT_HUB_OPENCODE_MODEL: "provider/env", AGENT_HUB_OPENCODE_EFFORT: "max" },
    });
    expect(unified.argv).toContain("provider/unified");
    expect(unified.argv).toContain("max");

    const namespaced = buildOpenCodeCommand({
      request: {
        prompt: "review",
        metadata: { model: "provider/unified", opencode: { model: "provider/native" } },
      },
      effectiveCliSessionRef: createOpenCodeSessionRef(null),
      env: { AGENT_HUB_OPENCODE_MODEL: "provider/env" },
    });
    expect(namespaced.argv).toContain("provider/native");
    expect(namespaced.argv).not.toContain("provider/unified");
    expect(namespaced.argv).not.toContain("provider/env");
  });

  it("rejects unsupported permission and add_dirs semantics", () => {
    expect(() =>
      buildOpenCodeCommand({
        request: { prompt: "review", metadata: { permission: "read-only" } },
        effectiveCliSessionRef: createOpenCodeSessionRef(null),
        env: {},
      }),
    ).toThrow(/only --auto/);
    expect(() =>
      buildOpenCodeCommand({
        request: {
          prompt: "review",
          metadata: {},
          resolved_metadata: { opencode: { add_dirs: ["/tmp/extra"] } },
        },
        effectiveCliSessionRef: createOpenCodeSessionRef(null),
        env: {},
      }),
    ).toThrow(/no add-dir boundary/);
  });

  it("extracts the session ref from a live event", () => {
    expect(openCodeSessionRefFromEvent({ type: "step_start", sessionID: SESSION_ID })).toEqual({
      agent_id: "opencode",
      native_session_id: SESSION_ID,
    });
    expect(openCodeSessionRefFromEvent({ type: "step_start", sessionID: "--help" })).toBeNull();
  });

  it("uses the last text event and returns the session ref", () => {
    const parsed = parseOpenCodeStdout(successStdout("done"));
    expect(parsed.resultText).toBe("done");
    expect(parsed.cliSessionRef).toEqual({
      agent_id: "opencode",
      native_session_id: SESSION_ID,
    });

    expect(
      interpretOpenCodeExit({ code: 0, signal: null, stdout: successStdout("done"), stderr: "" }),
    ).toMatchObject({
      status: "completed",
      resultText: "done",
      cliSessionRef: { agent_id: "opencode", native_session_id: SESSION_ID },
    });
  });

  it("maps structured OpenCode failures onto agent_error", () => {
    const stdout = JSON.stringify({
      type: "error",
      sessionID: SESSION_ID,
      error: {
        name: "UnknownError",
        data: { message: "Unexpected server error. Check server logs for details." },
      },
    });
    expect(
      interpretOpenCodeExit({ code: 1, signal: null, stdout, stderr: "" }),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "agent_error",
        message: "Unexpected server error. Check server logs for details.",
        cli_session_ref: { agent_id: "opencode", native_session_id: SESSION_ID },
      },
    });
  });

  it("rejects conflicting session ids and missing text", () => {
    const conflict = [
      JSON.stringify({ type: "text", sessionID: SESSION_ID, part: { type: "text", text: "a" } }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_aaaaaaaaaaaaaaaa",
        part: { type: "text", text: "b" },
      }),
    ].join("\n");
    expect(
      interpretOpenCodeExit({ code: 0, signal: null, stdout: conflict, stderr: "" }).error.code,
    ).toBe("stdout_parse_failed");
    expect(
      interpretOpenCodeExit({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ type: "step_finish", sessionID: SESSION_ID }),
        stderr: "",
      }).error.message,
    ).toMatch(/text event/);
  });
});

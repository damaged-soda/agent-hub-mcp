import {
  CLAUDE_AGENT_ID,
  buildClaudeCommand,
  createClaudeSessionRef,
  getClaudeAvailability,
  interpretClaudeExit,
  listClaudeAgent,
} from "./claude-adapter.js";
import {
  CODEX_AGENT_ID,
  buildCodexCommand,
  codexSessionRefFromEvent,
  createCodexSessionRef,
  getCodexAvailability,
  interpretCodexExit,
  listCodexAgent,
} from "./codex-adapter.js";
import {
  KIMI_AGENT_ID,
  buildKimiCommand,
  createKimiSessionRef,
  getKimiAvailability,
  interpretKimiExit,
  listKimiAgent,
} from "./kimi-adapter.js";

const ADAPTERS = new Map([
  [
    CLAUDE_AGENT_ID,
    {
      agentId: CLAUDE_AGENT_ID,
      displayName: "Claude Code",
      metadataKey: "claude",
      getAvailability: getClaudeAvailability,
      listAgent: listClaudeAgent,
      createSessionRef: createClaudeSessionRef,
      buildCommand: buildClaudeCommand,
      interpretExit: interpretClaudeExit,
      sessionRefFromEvent: null,
    },
  ],
  [
    CODEX_AGENT_ID,
    {
      agentId: CODEX_AGENT_ID,
      displayName: "Codex",
      metadataKey: "codex",
      getAvailability: getCodexAvailability,
      listAgent: listCodexAgent,
      createSessionRef: createCodexSessionRef,
      buildCommand: buildCodexCommand,
      interpretExit: interpretCodexExit,
      sessionRefFromEvent: codexSessionRefFromEvent,
    },
  ],
  [
    KIMI_AGENT_ID,
    {
      agentId: KIMI_AGENT_ID,
      displayName: "Kimi Code",
      metadataKey: KIMI_AGENT_ID,
      getAvailability: getKimiAvailability,
      listAgent: listKimiAgent,
      createSessionRef: createKimiSessionRef,
      buildCommand: buildKimiCommand,
      interpretExit: interpretKimiExit,
      sessionRefFromEvent: null,
    },
  ],
]);

export function allAdapters() {
  return Array.from(ADAPTERS.values());
}

export function getAdapter(agentId) {
  const adapter = ADAPTERS.get(agentId);
  if (!adapter) {
    throw new Error(`Unsupported agent_id: ${agentId}`);
  }
  return adapter;
}

import {
  CLAUDE_AGENT_ID,
  CLAUDE_CREDENTIAL_ENV_KEYS,
  CLAUDE_DISCUSSION_CAPABILITIES,
  buildClaudeCommand,
  createClaudeSessionRef,
  getClaudeAvailability,
  interpretClaudeExit,
  listClaudeAgent,
  preflightClaudeSession,
  prepareClaudeLaunchEnvironment,
  verifyClaudeSession,
} from "./claude-adapter.js";
import {
  CODEX_AGENT_ID,
  CODEX_DISCUSSION_CAPABILITIES,
  buildCodexCommand,
  codexSessionRefFromEvent,
  createCodexSessionRef,
  getCodexAvailability,
  interpretCodexExit,
  listCodexAgent,
} from "./codex-adapter.js";
import {
  KIMI_AGENT_ID,
  KIMI_DISCUSSION_CAPABILITIES,
  buildKimiCommand,
  createKimiSessionRef,
  getKimiAvailability,
  interpretKimiExit,
  listKimiAgent,
} from "./kimi-adapter.js";
import {
  OPENCODE_AGENT_ID,
  OPENCODE_DISCUSSION_CAPABILITIES,
  buildOpenCodeCommand,
  createOpenCodeSessionRef,
  getOpenCodeAvailability,
  interpretOpenCodeExit,
  listOpenCodeAgent,
  openCodeSessionRefFromEvent,
} from "./opencode-adapter.js";

const ADAPTERS = new Map([
  [
    CLAUDE_AGENT_ID,
    {
      agentId: CLAUDE_AGENT_ID,
      displayName: "Claude Code",
      metadataKey: "claude",
      credentialEnvKeys: CLAUDE_CREDENTIAL_ENV_KEYS,
      getAvailability: getClaudeAvailability,
      listAgent: listClaudeAgent,
      createSessionRef: createClaudeSessionRef,
      buildCommand: buildClaudeCommand,
      prepareLaunchEnvironment: prepareClaudeLaunchEnvironment,
      interpretExit: interpretClaudeExit,
      preflightSession: preflightClaudeSession,
      verifySession: verifyClaudeSession,
      sessionRefFromEvent: null,
      discussionCapabilities: CLAUDE_DISCUSSION_CAPABILITIES,
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
      discussionCapabilities: CODEX_DISCUSSION_CAPABILITIES,
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
      discussionCapabilities: KIMI_DISCUSSION_CAPABILITIES,
    },
  ],
  [
    OPENCODE_AGENT_ID,
    {
      agentId: OPENCODE_AGENT_ID,
      displayName: "OpenCode",
      metadataKey: OPENCODE_AGENT_ID,
      getAvailability: getOpenCodeAvailability,
      listAgent: listOpenCodeAgent,
      createSessionRef: createOpenCodeSessionRef,
      buildCommand: buildOpenCodeCommand,
      interpretExit: interpretOpenCodeExit,
      sessionRefFromEvent: openCodeSessionRefFromEvent,
      discussionCapabilities: OPENCODE_DISCUSSION_CAPABILITIES,
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

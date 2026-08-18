import type { AgentState, EventSummary, SessionState } from "../shared/contracts.js";
import type { RpcFrame } from "./rpc-frame.js";
import { sanitizeMetadata, sanitizeText } from "./security.js";

export interface NormalizedRpcEvent {
  type: string;
  summary: string;
  severity: EventSummary["severity"];
  metadata: Record<string, unknown>;
  persist: boolean;
  publicText?: string;
  agentState?: AgentState;
  sessionState?: SessionState;
  terminal?: boolean;
}

const IGNORED_FRAME_TYPES: Readonly<Record<string, true>> = {
  ready: true,
  response: true,
  rpc_chunk: true,
  available_commands_update: true,
  model_changed: true,
  thinking_level_changed: true,
  todo_reminder: true,
  todo_auto_clear: true,
};

const PRIVATE_DELTA_TYPES: Readonly<Record<string, true>> = {
  thinking_delta: true,
  reasoning_delta: true,
  thinking_start: true,
  thinking_end: true,
  reasoning_start: true,
  reasoning_end: true,
};

export function normalizeRpcEvent(frame: RpcFrame): NormalizedRpcEvent | null {
  if (IGNORED_FRAME_TYPES[frame.type]) {
    return null;
  }
  if (frame.type === "agent_start") {
    return lifecycle("omp.agent_start", "OMP agent turn started", "running", "streaming");
  }
  if (frame.type === "agent_end") {
    const terminal = frame.isTerminal !== false;
    return {
      ...lifecycle(
        terminal ? "omp.agent_end" : "omp.agent_maintenance",
        terminal ? "OMP agent turn completed" : "OMP maintenance ended; more work remains scheduled",
        terminal ? "idle" : "running",
        terminal ? "idle" : "streaming",
      ),
      terminal,
    };
  }
  if (frame.type === "turn_start") {
    return lifecycle("omp.turn_start", "OMP model turn started", "running", "streaming");
  }
  if (frame.type === "turn_end") {
    return lifecycle("omp.turn_end", "OMP model turn ended", "running", "streaming");
  }
  if (frame.type === "message_update") {
    return normalizeMessageUpdate(frame);
  }
  if (frame.type === "message_start") {
    return {
      type: "omp.message_start",
      summary: "Assistant response started",
      severity: "info",
      metadata: {},
      persist: true,
    };
  }
  if (frame.type === "message_end") {
    return {
      type: "omp.message_end",
      summary: "Assistant response ended",
      severity: "info",
      metadata: {},
      persist: true,
    };
  }
  if (frame.type.startsWith("tool_execution_")) {
    const toolName = typeof frame.toolName === "string" ? sanitizeText(frame.toolName, 100) : "unnamed tool";
    const phase = frame.type.slice("tool_execution_".length);
    return {
      type: `omp.tool.${phase}`,
      summary: `${toolName}: ${phase}`,
      severity: phase === "end" && frame.isError === true ? "error" : "info",
      metadata: { toolName, phase, isError: frame.isError === true },
      persist: phase !== "update",
    };
  }
  if (frame.type === "extension_error") {
    return {
      type: "omp.extension_error",
      summary: sanitizeText(typeof frame.error === "string" ? frame.error : "OMP extension error", 500),
      severity: "error",
      metadata: { event: frame.event, extension: "redacted" },
      persist: true,
      agentState: "failed",
    };
  }
  if (frame.type === "auto_retry_start" || frame.type === "retry_fallback_applied") {
    return {
      type: `omp.${frame.type}`,
      summary: "OMP attempted an automatic retry or fallback",
      severity: "warning",
      metadata: {},
      persist: true,
    };
  }
  if (frame.type === "auto_compaction_start" || frame.type === "auto_compaction_end") {
    return {
      type: `omp.${frame.type}`,
      summary: "OMP context compaction event",
      severity: "warning",
      metadata: {},
      persist: true,
    };
  }
  if (frame.type === "notice") {
    return {
      type: "omp.notice",
      summary: sanitizeText(typeof frame.message === "string" ? frame.message : "OMP notice", 500),
      severity: frame.level === "error" ? "error" : frame.level === "warning" ? "warning" : "info",
      metadata: {},
      persist: true,
    };
  }
  if (frame.type === "prompt_result" || frame.type === "command_output") {
    return {
      type: `omp.${frame.type}`,
      summary:
        frame.type === "prompt_result" ? "Local OMP prompt completed" : "Local OMP command produced output",
      severity: "info",
      metadata: {},
      persist: true,
    };
  }
  if (frame.type === "irc_message") {
    return {
      type: "omp.internal_message",
      summary: "OMP internal message event",
      severity: "info",
      metadata: sanitizeMetadata({ sender: frame.sender, target: frame.target }) as Record<string, unknown>,
      persist: true,
    };
  }
  return {
    type: "omp.unknown_frame",
    summary: `Unsupported OMP event type: ${sanitizeText(frame.type, 120)}`,
    severity: "warning",
    metadata: { frameType: sanitizeText(frame.type, 120) },
    persist: true,
  };
}

function normalizeMessageUpdate(frame: RpcFrame): NormalizedRpcEvent | null {
  const assistantEvent = frame.assistantMessageEvent;
  if (assistantEvent === null || Array.isArray(assistantEvent) || typeof assistantEvent !== "object") {
    return null;
  }
  const eventRecord = assistantEvent as Record<string, unknown>;
  const eventType = typeof eventRecord.type === "string" ? eventRecord.type : "unknown";
  if (PRIVATE_DELTA_TYPES[eventType]) {
    return null;
  }
  if (eventType === "text_delta" && typeof eventRecord.delta === "string") {
    const publicText = sanitizeText(eventRecord.delta, 4_000);
    return {
      type: "omp.text_delta",
      summary: publicText,
      severity: "info",
      metadata: {},
      persist: false,
      publicText,
    };
  }
  if (eventType.startsWith("toolcall_")) {
    return {
      type: "omp.tool_call_delta",
      summary: "OMP prepared an allowlisted tool call",
      severity: "info",
      metadata: { eventType },
      persist: false,
    };
  }
  return null;
}

function lifecycle(
  type: string,
  summary: string,
  agentState: AgentState,
  sessionState: SessionState,
): NormalizedRpcEvent {
  return {
    type,
    summary,
    severity: "info",
    metadata: {},
    persist: true,
    agentState,
    sessionState,
  };
}

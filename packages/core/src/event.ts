import type { PolicyAction } from "./policy.ts";

export type EventType =
  | "pre_tool"
  | "post_tool"
  | "user_prompt"
  | "stop"
  | "session_start"
  | "session_end"
  | "notification"
  | "circuit_breaker_triggered";

export interface AuditEvent {
  id: string;
  sessionId: string;
  sequenceNum: number;
  eventType: EventType;
  toolName?: string;
  toolInput?: Record<string, unknown> | string;
  toolOutput?: Record<string, unknown> | string;
  isBlobStored?: boolean;
  policyVerdict?: PolicyAction;
  policyReason?: string;
  executionDurationMs?: number;
  modelName?: string;
  tokensInput?: number;
  tokensOutput?: number;
  estimatedCostUsd?: number;
  createdAt: number;
}

export interface FileSnapshot {
  id: string;
  sessionId: string;
  eventId?: string;
  filePath: string;
  isTestFile: boolean;
  changeType: "created" | "modified" | "deleted";
  diffUnified: string;
  createdAt: number;
}

export function createAuditEvent(params: {
  sessionId: string;
  sequenceNum: number;
  eventType: EventType;
  toolName?: string;
  toolInput?: Record<string, unknown> | string;
  toolOutput?: Record<string, unknown> | string;
  policyVerdict?: PolicyAction;
  policyReason?: string;
  executionDurationMs?: number;
  modelName?: string;
  tokensInput?: number;
  tokensOutput?: number;
  estimatedCostUsd?: number;
}): AuditEvent {
  const now = Date.now();
  return {
    id: `evt_${params.sequenceNum}_${Math.random().toString(36).slice(2, 8)}_${now}`,
    sessionId: params.sessionId,
    sequenceNum: params.sequenceNum,
    eventType: params.eventType,
    toolName: params.toolName,
    toolInput: params.toolInput,
    toolOutput: params.toolOutput,
    policyVerdict: params.policyVerdict,
    policyReason: params.policyReason,
    executionDurationMs: params.executionDurationMs,
    modelName: params.modelName,
    tokensInput: params.tokensInput,
    tokensOutput: params.tokensOutput,
    estimatedCostUsd: params.estimatedCostUsd,
    createdAt: now,
  };
}

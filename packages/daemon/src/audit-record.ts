import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentHookPayload,
  AgentType,
  AuditEvent,
  EventType,
  HookEventName,
  PolicyEvaluationResult,
} from "../../core/src/index.ts";
import { StorageEngine } from "../../storage/src/index.ts";
import { getRunningDaemonLock } from "./lock.ts";

/**
 * One audit row per hook call, built the same way whether the daemon or the hook process writes it,
 * so `ctrlplane audit` and the dashboard cannot tell the two apart.
 */

export const EVENT_TYPE: Record<HookEventName, EventType> = {
  PreToolUse: "pre_tool",
  PostToolUse: "post_tool",
  UserPromptSubmit: "user_prompt",
  Stop: "stop",
  SubagentStop: "subagent_stop",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  PreCompact: "pre_compact",
  Notification: "notification",
};

export const DEFAULT_SESSION = "sess_default";
const NO_COMMIT = "0000000000000000000000000000000000000000";

/** What the log says about a decision: an observe-mode hit is an ALLOW whose reason says what it would have done. */
export function describeOutcome(result: PolicyEvaluationResult): {
  observedOnly: boolean;
  reason: string;
  ruleId?: string;
} {
  const observed = result.decision === "ALLOW" ? result.observed?.[0] : undefined;
  return {
    observedOnly: observed !== undefined,
    reason: observed ? `Observe mode: would ${observed.wouldDecide} — ${observed.reason}` : result.reason,
    ruleId: result.matchedRuleId ?? result.observed?.[0]?.ruleId,
  };
}

/** The row for one hook call, without its id and sequence number. */
export function auditEventFor(
  payload: AgentHookPayload,
  sessionId: string,
  result: PolicyEvaluationResult,
  executionDurationMs: number,
  createdAt: number,
): Omit<AuditEvent, "id" | "sequenceNum"> {
  const outcome = describeOutcome(result);
  return {
    sessionId,
    eventType: EVENT_TYPE[payload.hookEventName] ?? "notification",
    toolName: payload.toolName,
    toolInput: payload.toolInput ?? (payload.prompt !== undefined ? { prompt: payload.prompt } : undefined),
    toolOutput: payload.toolResponse,
    policyVerdict: result.decision,
    policyReason: outcome.reason,
    ruleId: outcome.ruleId,
    executionDurationMs,
    createdAt,
  };
}

export function auditEventId(sessionId: string, sequenceNum: number, createdAt: number): string {
  return `evt_${sessionId}_${sequenceNum}_${createdAt}`;
}

/**
 * Records a hook call from the hook process itself, for when no daemon is running. Only in a project that was
 * set up (`.ctrlplane` exists), and never while a daemon runs: a daemon that answered too slowly still records
 * the call itself, and writing it here as well would count it twice. Git details are left as unknown, because
 * the hook must exit promptly.
 */
export function recordWithoutDaemon(
  payload: AgentHookPayload,
  projectRoot: string,
  result: PolicyEvaluationResult,
  executionDurationMs: number,
): boolean {
  if (!existsSync(join(projectRoot, ".ctrlplane")) || getRunningDaemonLock(projectRoot)) return false;
  const sessionId = payload.sessionId ?? DEFAULT_SESSION;
  const createdAt = Date.now();
  const storage = new StorageEngine(join(projectRoot, ".ctrlplane", "audit.db"));
  try {
    storage.ensureSession({
      id: sessionId,
      agentType: (payload.agent ?? "custom") as AgentType,
      projectPath: projectRoot,
      gitBranch: "unknown",
      baseCommitSha: NO_COMMIT,
      status: "active",
      startedAt: createdAt,
      metadata: payload.transcriptPath ? { transcriptPath: payload.transcriptPath } : undefined,
    });
    storage.appendEvent(auditEventFor(payload, sessionId, result, executionDurationMs, createdAt), auditEventId);
    if (payload.hookEventName === "SessionEnd") storage.updateSessionStatus(sessionId, "completed");
    return true;
  } finally {
    storage.close();
  }
}

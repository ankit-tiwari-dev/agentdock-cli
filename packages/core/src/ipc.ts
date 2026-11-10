import type { EventType } from "./event.ts";
import type { PolicyAction } from "./policy.ts";

export interface AgentHookPayload {
  hookEventName:
    | "PreToolUse"
    | "PostToolUse"
    | "UserPromptSubmit"
    | "Stop"
    | "SessionStart"
    | "SessionEnd";
  sessionId?: string;
  cwd: string;
  toolName?: string;
  toolInput?: Record<string, unknown> | string;
  toolResponse?: Record<string, unknown> | string;
  prompt?: string;
}

export interface HookVerdictResponse {
  decision: PolicyAction;
  exitCode: 0 | 2;
  stderrMessage?: string;
  stdoutMessage?: string;
  steeringInstruction?: string;
  latencyMs: number;
}

export interface DaemonStatus {
  pid: number;
  uptimeSeconds: number;
  ipcPath: string;
  activeSessionId: string | null;
  databaseSizeBytes: number;
  connectedAgentsCount: number;
  version: string;
}

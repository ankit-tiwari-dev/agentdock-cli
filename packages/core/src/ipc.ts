import type { PolicyAction } from "./policy.ts";

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "Notification";

export type AgentKind = "claude-code" | "codex" | "opencode" | "cursor" | "gemini" | "custom";

export interface AgentHookPayload {
  hookEventName: HookEventName;
  sessionId?: string;
  cwd: string;
  toolName?: string;
  toolInput?: Record<string, unknown> | string;
  toolResponse?: Record<string, unknown> | string;
  prompt?: string;
  agent?: AgentKind;
  transcriptPath?: string;
  permissionMode?: string;
  /** SessionStart: startup | resume | clear | compact. PreCompact: manual | auto. */
  source?: string;
  /** Stop: true when the agent is already continuing because a Stop hook blocked it. */
  stopHookActive?: boolean;
  /** Set when the call comes from a subagent rather than the main agent. */
  subagentId?: string;
}

/**
 * Manages the daemon itself. Only `sendDaemonControl` builds one; the hook path never emits `kind`,
 * so an agent's hook payload cannot turn into a control frame.
 */
export interface DaemonControlFrame {
  kind: "control";
  control: "shutdown" | "ping";
  /** The per-start token from `daemon.lock`; a shutdown without the right one is refused. */
  token?: string;
}

export interface HookVerdictResponse {
  decision: PolicyAction;
  exitCode: 0 | 2;
  stderrMessage?: string;
  stdoutMessage?: string;
  steeringInstruction?: string;
  matchedRuleId?: string;
  /** True when a rule matched in observe mode: logged, not enforced. */
  observedOnly?: boolean;
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

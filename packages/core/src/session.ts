export type AgentType = "claude-code" | "codex" | "opencode" | "cursor" | "gemini" | "custom";

export type SessionStatus = "active" | "completed" | "aborted" | "paused";

export interface Session {
  id: string;
  agentType: AgentType;
  projectPath: string;
  gitBranch: string;
  baseCommitSha: string;
  headCommitSha?: string;
  specId?: string;
  status: SessionStatus;
  startedAt: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
}

export function createSession(params: {
  id?: string;
  agentType: AgentType;
  projectPath: string;
  gitBranch?: string;
  baseCommitSha?: string;
  specId?: string;
}): Session {
  const now = Date.now();
  return {
    id: params.id ?? `sess_${Math.random().toString(36).slice(2, 10)}_${now}`,
    agentType: params.agentType,
    projectPath: params.projectPath,
    gitBranch: params.gitBranch ?? "main",
    baseCommitSha: params.baseCommitSha ?? "0000000000000000000000000000000000000000",
    specId: params.specId,
    status: "active",
    startedAt: now,
  };
}

export function validateSession(session: unknown): session is Session {
  if (typeof session !== "object" || session === null) return false;
  const s = session as Partial<Session>;
  return (
    typeof s.id === "string" &&
    typeof s.agentType === "string" &&
    typeof s.projectPath === "string" &&
    typeof s.gitBranch === "string" &&
    typeof s.baseCommitSha === "string" &&
    typeof s.status === "string" &&
    typeof s.startedAt === "number"
  );
}

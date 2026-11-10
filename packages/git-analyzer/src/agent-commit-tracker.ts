/**
 * Git-backed Agent Commit Tracker and Trailer Generator.
 * Adapted with enhancements from aGiTrack (Apache License 2.0).
 */

import { execFileSync } from "node:child_process";

export interface AgentCommitMetadata {
  agentId: string;
  agentType?: string;
  turn?: number;
  modelName?: string;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
  toolsUsed?: string[];
  verifiedCriteria?: string[];
}

export interface BuildCommitMessageParams {
  subject: string;
  summary?: string;
  metadata: AgentCommitMetadata;
}

export const AGENT_COMMIT_HEADER = "# AgentDock Metadata";

/**
 * Masks absolute filesystem paths to avoid leaking user home directories
 * or machine layouts into shared Git history.
 */
export function maskAbsolutePaths(text: string): string {
  // Mask Windows drive paths preserving the filename: C:\Users\...\file.txt -> [PATH]/file.txt
  let masked = text.replace(/(?<![\w.-])(?:[A-Za-z]:[\\/]|\\\\[^\s\\<>"'`]+\\)[^\s<>"'`|,;]*[\\/]([^\\/\s<>"'`|,;]+)/g, "[PATH]/$1");
  // Fallback for bare Windows root path without filename
  masked = masked.replace(/(?<![\w.-])(?:[A-Za-z]:[\\/]|\\\\[^\s\\<>"'`]+\\)[^\s<>"'`|,;]*/g, "[PATH]");

  // Mask Unix absolute paths preserving filename: /home/alice/.../main.js -> [PATH]/main.js
  masked = masked.replace(/(?<![\w.~-])\/(?:home|Users|etc|var|usr)\/[^\s<>"'`|,;]*\/([^/\s<>"'`|,;]+)/g, "[PATH]/$1");
  // Fallback for bare Unix root path without filename
  masked = masked.replace(/(?<![\w.~-])\/(?:home|Users|etc|var|usr)\/[^\s<>"'`|,;]*/g, "[PATH]");

  return masked;
}

/**
 * Builds a Git commit message following Git trailer conventions.
 */
export function buildAgentCommitMessage(params: BuildCommitMessageParams): string {
  const cleanSubject = params.subject.trim().slice(0, 72);
  const subjectLine = cleanSubject.startsWith("[AgentDock]")
    ? cleanSubject
    : `[AgentDock] ${cleanSubject}`.slice(0, 72);

  const lines: string[] = [subjectLine, ""];

  if (params.summary) {
    lines.push(maskAbsolutePaths(params.summary.trim()), "");
  }

  // Append structured metadata trailer
  lines.push(AGENT_COMMIT_HEADER);
  lines.push(`agent_id: ${params.metadata.agentId}`);
  if (params.metadata.agentType) {
    lines.push(`agent_type: ${params.metadata.agentType}`);
  }
  if (params.metadata.turn !== undefined) {
    lines.push(`turn: ${params.metadata.turn}`);
  }
  if (params.metadata.modelName) {
    lines.push(`model: ${params.metadata.modelName}`);
  }
  if (params.metadata.tokensInput !== undefined) {
    lines.push(`tokens_input: ${params.metadata.tokensInput}`);
  }
  if (params.metadata.tokensOutput !== undefined) {
    lines.push(`tokens_output: ${params.metadata.tokensOutput}`);
  }
  if (params.metadata.costUsd !== undefined) {
    lines.push(`cost_usd: $${params.metadata.costUsd.toFixed(4)}`);
  }
  if (params.metadata.toolsUsed && params.metadata.toolsUsed.length > 0) {
    lines.push(`tools_used: ${params.metadata.toolsUsed.join(", ")}`);
  }
  if (params.metadata.verifiedCriteria && params.metadata.verifiedCriteria.length > 0) {
    lines.push(`verified_criteria: ${params.metadata.verifiedCriteria.join(", ")}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Parses AgentDock metadata trailers from an existing commit message.
 */
export function parseAgentCommitTrailers(commitBody: string): Partial<AgentCommitMetadata> | null {
  if (!commitBody.includes(AGENT_COMMIT_HEADER)) {
    return null;
  }

  const [, trailerSection] = commitBody.split(AGENT_COMMIT_HEADER);
  const metadata: Partial<AgentCommitMetadata> = {};

  const lines = trailerSection.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    switch (key) {
      case "agent_id":
        metadata.agentId = value;
        break;
      case "agent_type":
        metadata.agentType = value;
        break;
      case "turn":
        metadata.turn = parseInt(value, 10);
        break;
      case "model":
        metadata.modelName = value;
        break;
      case "tokens_input":
        metadata.tokensInput = parseInt(value, 10);
        break;
      case "tokens_output":
        metadata.tokensOutput = parseInt(value, 10);
        break;
      case "cost_usd":
        metadata.costUsd = parseFloat(value.replace("$", ""));
        break;
      case "tools_used":
        metadata.toolsUsed = value.split(",").map((s) => s.trim());
        break;
      case "verified_criteria":
        metadata.verifiedCriteria = value.split(",").map((s) => s.trim());
        break;
    }
  }

  return metadata;
}

/**
 * Stages modified files and creates a traceable Git commit for the current agent turn.
 */
export function commitAgentTurn(params: {
  cwd: string;
  subject: string;
  summary?: string;
  metadata: AgentCommitMetadata;
}): string {
  const commitMsg = buildAgentCommitMessage(params);

  // Stage changes
  execFileSync("git", ["add", "-A"], { cwd: params.cwd, stdio: "pipe" });

  // Commit with generated message
  execFileSync("git", ["commit", "-m", commitMsg], {
    cwd: params.cwd,
    stdio: "pipe",
    encoding: "utf-8",
  });

  // Return new commit SHA
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: params.cwd,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();

  return sha;
}

import type { AgentHookPayload, HookVerdictResponse } from "../../core/src/index.ts";

export interface HookProcessOutput {
  exitCode: 0 | 2;
  stdout?: string;
  stderr?: string;
}

const PREFIX = "[ctrlplane]";

/**
 * Turns a verdict into what the agent's hook runner understands.
 * Claude Code and Codex share the protocol: exit 2 + stderr blocks, JSON on stdout carries
 * `permissionDecision` ("ask") and `additionalContext` (steering text the model reads).
 * Agents without an "ask" channel get a block that tells the model to ask the developer.
 */
export function formatHookOutput(payload: AgentHookPayload, verdict: HookVerdictResponse, extraContext?: string): HookProcessOutput {
  const event = payload.hookEventName;
  const reason = verdict.stderrMessage ?? verdict.steeringInstruction ?? "";
  const supportsAsk = payload.agent === "claude-code" || payload.agent === undefined;

  if (verdict.decision === "DENY") {
    if (event === "Stop" || event === "SubagentStop") {
      return { exitCode: 2, stderr: `${PREFIX} MANDATORY ACTION REQUIRED before you finish: ${reason} Do this yourself; do not ask the user.` };
    }
    if (event === "UserPromptSubmit" || event === "PostToolUse") {
      return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason: `${PREFIX} ${reason}` }) };
    }
    return { exitCode: 2, stderr: `${PREFIX} ${reason}` };
  }

  if (verdict.decision === "REQUIRE_MANUAL_APPROVAL") {
    if (event === "PreToolUse" && supportsAsk) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `${PREFIX} ${reason}`,
          },
        }),
      };
    }
    return { exitCode: 2, stderr: `${PREFIX} Developer approval required: ${reason} Stop and ask the developer how to proceed.` };
  }

  const context = [verdict.decision === "INSTRUCT" ? `${PREFIX} ${reason}` : "", extraContext ?? ""].filter(Boolean).join("\n\n");
  if (!context) return { exitCode: 0 };

  if (event === "PreToolUse" || event === "PostToolUse" || event === "UserPromptSubmit" || event === "SessionStart") {
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) };
  }
  // A steer at turn end must not force the agent to keep going; show it to the developer instead.
  return { exitCode: 0, stdout: JSON.stringify({ systemMessage: context }) };
}

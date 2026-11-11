import { readFileSync, existsSync } from "node:fs";
import { findLocalClaudeTranscripts, parseClaudeTranscript } from "../../../agent-adapters/src/backtracer.ts";

export function handleBacktraceCommand(targetPath?: string): string {
  if (targetPath && existsSync(targetPath)) {
    const raw = readFileSync(targetPath, "utf-8");
    const session = parseClaudeTranscript(raw, targetPath);
    return formatBacktraceSession(session);
  }

  const transcripts = findLocalClaudeTranscripts();
  if (transcripts.length === 0) {
    return "No local agent transcripts found in ~/.claude/projects/. Pass a direct transcript path: `ctrlplane backtrace <path.jsonl>`";
  }

  const lines = [`Found ${transcripts.length} local agent transcript(s):`, ""];

  for (const path of transcripts.slice(0, 5)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const session = parseClaudeTranscript(raw, path);
      lines.push(`• [${session.agentType}] ${path}`);
      lines.push(
        `  Turns: ${session.totalTurns} | Total Tokens: ${session.totalTokens} | Spend: $${session.totalCostUsd.toFixed(4)}`,
      );
    } catch {
      lines.push(`• ${path} (unreadable)`);
    }
  }

  return lines.join("\n");
}

function formatBacktraceSession(session: ReturnType<typeof parseClaudeTranscript>): string {
  const lines = [
    `=== AgentDock Backtrace Recovery ===`,
    `Session:      ${session.sessionId}`,
    `Agent Type:   ${session.agentType}`,
    `Total Turns:  ${session.totalTurns}`,
    `Total Tokens: ${session.totalTokens}`,
    `Total Spend:  $${session.totalCostUsd.toFixed(4)}`,
    "",
    "Turn Breakdown:",
  ];

  for (const turn of session.turns) {
    lines.push(
      `  [Turn ${turn.turnIndex + 1}] Tokens: ${turn.tokensInput} in / ${turn.tokensOutput} out (${turn.cost.formattedCost})`,
    );
    if (turn.toolsUsed.length > 0) {
      lines.push(`    Tools: ${turn.toolsUsed.join(", ")}`);
    }
    if (turn.filesModified.length > 0) {
      lines.push(`    Files: ${turn.filesModified.join(", ")}`);
    }
  }

  return lines.join("\n");
}

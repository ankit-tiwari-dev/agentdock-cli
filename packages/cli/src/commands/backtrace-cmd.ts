import { readFileSync, existsSync, statSync } from "node:fs";
import { findLocalClaudeTranscripts, parseClaudeTranscript } from "../../../agent-adapters/src/backtracer.ts";
import type { CommandResult } from "./policies-cmd.ts";

type Session = ReturnType<typeof parseClaudeTranscript>;

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Models in a session with no catalog price; their spend is only an estimate at the default rate. */
function unknownModels(session: Session): string[] {
  return [...new Set(session.turns.filter((t) => t.cost.unknownModel).map((t) => t.cost.model))];
}

function unknownModelWarnings(session: Session): string[] {
  return unknownModels(session).map(
    (m) => `WARNING: unknown model '${m}': no price in the catalog, spend is estimated at the default rate.`,
  );
}

export function handleBacktraceCommand(targetPath?: string): CommandResult {
  if (targetPath) {
    // A path that was given but does not exist is an error, not a reason to list other transcripts.
    if (!existsSync(targetPath)) {
      return { output: `Transcript not found: ${targetPath}`, exitCode: 1 };
    }
    const raw = readFileSync(targetPath, "utf-8");
    const session = parseClaudeTranscript(raw, targetPath);
    return { output: formatBacktraceSession(session), exitCode: 0 };
  }

  // Newest first, so the session that just finished is at the top.
  const transcripts = findLocalClaudeTranscripts()
    .map((path) => ({ path, mtime: mtimeOf(path) }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((t) => t.path);
  if (transcripts.length === 0) {
    return {
      output:
        "No local agent transcripts found in ~/.claude/projects/. Pass a direct transcript path: `ctrlplane backtrace <path.jsonl>`",
      exitCode: 0,
    };
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
      lines.push(...unknownModelWarnings(session).map((w) => `  ${w}`));
    } catch {
      lines.push(`• ${path} (unreadable)`);
    }
  }

  return { output: lines.join("\n"), exitCode: 0 };
}

function formatBacktraceSession(session: Session): string {
  const lines = [
    `=== AgentDock Backtrace Recovery ===`,
    `Session:      ${session.sessionId}`,
    `Agent Type:   ${session.agentType}`,
    `Total Turns:  ${session.totalTurns}`,
    `Total Tokens: ${session.totalTokens}`,
    `Total Spend:  $${session.totalCostUsd.toFixed(4)}`,
    ...unknownModelWarnings(session),
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

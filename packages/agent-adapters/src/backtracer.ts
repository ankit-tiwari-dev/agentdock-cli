/**
 * Historical transcript backtracer and recovery engine.
 * Adapted with enhancements from aGiTrack (Apache License 2.0).
 * Scans local agent transcripts (Claude Code, Codex, AgentDock audit logs)
 * to reconstruct historical turns, tool usage, and token consumption.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { calculateTurnCost, type CostBreakdown } from "../../core/src/token-pricing.ts";

export interface ReconstructedTurn {
  turnIndex: number;
  timestamp: number;
  userPrompt?: string;
  assistantSummary?: string;
  toolsUsed: string[];
  filesModified: string[];
  tokensInput: number;
  tokensOutput: number;
  cost: CostBreakdown;
}

export interface ReconstructedSession {
  sessionId: string;
  agentType: string;
  transcriptPath: string;
  turns: ReconstructedTurn[];
  totalTurns: number;
  totalTokens: number;
  totalCostUsd: number;
  summary: string;
}

/**
 * Parses a Claude Code JSONL transcript into structured turns.
 */
export function parseClaudeTranscript(content: string, sessionId = "claude-session"): ReconstructedSession {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const turns: ReconstructedTurn[] = [];

  let currentTurnIndex = 0;
  let currentPrompt = "";
  let toolsInTurn: string[] = [];
  let filesInTurn: string[] = [];
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let turnTimestamp = Date.now();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Handle user prompts
      if (entry.type === "user" || entry.role === "user") {
        if (currentPrompt && (toolsInTurn.length > 0 || turnOutputTokens > 0)) {
          // Flush previous turn
          turns.push({
            turnIndex: currentTurnIndex++,
            timestamp: turnTimestamp,
            userPrompt: currentPrompt,
            toolsUsed: [...new Set(toolsInTurn)],
            filesModified: [...new Set(filesInTurn)],
            tokensInput: turnInputTokens,
            tokensOutput: turnOutputTokens,
            cost: calculateTurnCost({
              modelName: "claude-3-5-sonnet",
              inputTokens: turnInputTokens,
              outputTokens: turnOutputTokens,
            }),
          });
          toolsInTurn = [];
          filesInTurn = [];
          turnInputTokens = 0;
          turnOutputTokens = 0;
        }

        currentPrompt = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
        turnTimestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
      }

      // Handle assistant responses and tool calls
      if (entry.type === "assistant" || entry.role === "assistant") {
        if (entry.usage) {
          turnInputTokens += entry.usage.input_tokens ?? 0;
          turnOutputTokens += entry.usage.output_tokens ?? 0;
        }

        if (Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (block.type === "tool_use" || block.type === "tool_call") {
              const toolName = block.name ?? block.function?.name ?? "unknown";
              toolsInTurn.push(toolName);

              const input = block.input ?? block.function?.arguments;
              if (input && typeof input === "object") {
                const targetFile = input.file_path ?? input.path ?? input.filePath ?? input.file;
                if (typeof targetFile === "string") {
                  filesInTurn.push(targetFile);
                }
              }
            }
          }
        }
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  // Flush final turn
  if (currentPrompt || toolsInTurn.length > 0) {
    turns.push({
      turnIndex: currentTurnIndex++,
      timestamp: turnTimestamp,
      userPrompt: currentPrompt,
      toolsUsed: [...new Set(toolsInTurn)],
      filesModified: [...new Set(filesInTurn)],
      tokensInput: turnInputTokens,
      tokensOutput: turnOutputTokens,
      cost: calculateTurnCost({
        modelName: "claude-3-5-sonnet",
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
      }),
    });
  }

  const totalTokens = turns.reduce((acc, t) => acc + t.tokensInput + t.tokensOutput, 0);
  const totalCostUsd = turns.reduce((acc, t) => acc + t.cost.costUsd, 0);

  return {
    sessionId,
    agentType: "claude-code",
    transcriptPath: "in-memory",
    turns,
    totalTurns: turns.length,
    totalTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    summary: `Reconstructed ${turns.length} turns spanning ${totalTokens} tokens ($${totalCostUsd.toFixed(4)})`,
  };
}

/**
 * Finds local transcripts in Claude projects directory
 */
export function findLocalClaudeTranscripts(customDir?: string): string[] {
  const dir = customDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(dir)) return [];

  const found: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(join(entry.parentPath || dir, entry.name));
      }
    }
  } catch {
    // Return whatever was found
  }
  return found;
}


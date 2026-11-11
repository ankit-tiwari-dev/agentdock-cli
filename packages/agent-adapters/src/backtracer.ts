import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { calculateTurnCost } from "../../core/src/token-pricing.ts";
import type { CostBreakdown } from "../../core/src/token-pricing.ts";

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

const DEFAULT_SESSION_ID = "claude-session";
const DEFAULT_MODEL = "claude-3-5-sonnet";
const SUMMARY_LENGTH = 200;
const FILE_INPUT_KEYS = ["file_path", "path", "filePath", "file", "notebook_path"];

type JsonObject = Record<string, unknown>;

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface TurnDraft {
  timestamp: number;
  userPrompt?: string;
  lastAssistantText?: string;
  model?: string;
  tools: Set<string>;
  files: Set<string>;
  usageByMessage: Map<string, Usage>;
  anonymousUsage: Usage[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function toTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function parseLine(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textOfBlocks(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((block): block is JsonObject => isObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).trim())
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function newDraft(timestamp: number, userPrompt?: string): TurnDraft {
  return {
    timestamp,
    userPrompt,
    tools: new Set(),
    files: new Set(),
    usageByMessage: new Map(),
    anonymousUsage: [],
  };
}

function readUsage(usage: unknown): Usage | null {
  if (!isObject(usage)) return null;
  return {
    input: toCount(usage.input_tokens),
    output: toCount(usage.output_tokens),
    cacheRead: toCount(usage.cache_read_input_tokens),
    cacheWrite: toCount(usage.cache_creation_input_tokens),
  };
}

function recordAssistant(draft: TurnDraft, message: JsonObject): void {
  const model = message.model;
  // Claude Code labels locally generated messages with a model like "<synthetic>", which has no price.
  if (typeof model === "string" && model && !model.startsWith("<")) {
    draft.model = model;
  }

  const usage = readUsage(message.usage);
  if (usage) {
    // Claude Code writes one line per content block of a response, each repeating that response's usage.
    if (typeof message.id === "string" && message.id) {
      draft.usageByMessage.set(message.id, usage);
    } else {
      draft.anonymousUsage.push(usage);
    }
  }

  const content = message.content;
  if (typeof content === "string") {
    if (content.trim()) draft.lastAssistantText = content.trim();
    return;
  }
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      draft.lastAssistantText = block.text.trim();
    } else if (block.type === "tool_use") {
      if (typeof block.name === "string" && block.name) draft.tools.add(block.name);
      if (isObject(block.input)) {
        for (const key of FILE_INPUT_KEYS) {
          const value = block.input[key];
          if (typeof value === "string" && value) draft.files.add(value);
        }
      }
    }
  }
}

function summarize(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_LENGTH ? `${flat.slice(0, SUMMARY_LENGTH).trimEnd()}...` : flat;
}

function finishTurn(draft: TurnDraft, turnIndex: number): ReconstructedTurn {
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const usage of [...draft.usageByMessage.values(), ...draft.anonymousUsage]) {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
  }

  return {
    turnIndex,
    timestamp: draft.timestamp,
    userPrompt: draft.userPrompt,
    assistantSummary: summarize(draft.lastAssistantText),
    toolsUsed: [...draft.tools],
    filesModified: [...draft.files],
    tokensInput: totals.input,
    tokensOutput: totals.output,
    cost: calculateTurnCost({
      modelName: draft.model ?? DEFAULT_MODEL,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
    }),
  };
}

function describeSession(turns: ReconstructedTurn[], totalTokens: number, totalCostUsd: number): string {
  if (turns.length === 0) {
    return "No turns found in this transcript.";
  }
  const tools = new Set(turns.flatMap((t) => t.toolsUsed));
  const files = new Set(turns.flatMap((t) => t.filesModified));
  const turnWord = turns.length === 1 ? "turn" : "turns";
  return `${turns.length} ${turnWord}, ${totalTokens} tokens, $${totalCostUsd.toFixed(4)}; ${tools.size} distinct tools used, ${files.size} files touched.`;
}

export function parseClaudeTranscript(content: string, sessionId?: string): ReconstructedSession {
  const drafts: TurnDraft[] = [];
  let current: TurnDraft | undefined;

  for (const line of content.split(/\r?\n/)) {
    const record = parseLine(line);
    if (!record) continue;

    const message = isObject(record.message) ? record.message : record;
    const role = record.type ?? message.role;

    if (role === "user") {
      if (record.isMeta === true) continue;
      const prompt = textOfBlocks(message.content ?? record.content);
      if (prompt === undefined) continue;
      current = newDraft(toTimestamp(record.timestamp), prompt);
      drafts.push(current);
    } else if (role === "assistant") {
      if (!current) {
        current = newDraft(toTimestamp(record.timestamp));
        drafts.push(current);
      }
      recordAssistant(current, {
        ...message,
        content: message.content ?? record.content,
        usage: message.usage ?? record.usage,
        model: message.model ?? record.model,
      });
    }
  }

  const turns = drafts.map((draft, index) => finishTurn(draft, index));
  const totalTokens = turns.reduce((sum, t) => sum + t.cost.totalTokens, 0);
  const totalCostUsd = Math.round(turns.reduce((sum, t) => sum + t.cost.costUsd, 0) * 1e4) / 1e4;
  const id = sessionId ?? DEFAULT_SESSION_ID;

  return {
    sessionId: id,
    agentType: "claude-code",
    transcriptPath: id,
    turns,
    totalTurns: turns.length,
    totalTokens,
    totalCostUsd,
    summary: describeSession(turns, totalTokens, totalCostUsd),
  };
}

function collectJsonl(dir: string, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonl(fullPath, found);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(fullPath);
    }
  }
}

export function findLocalClaudeTranscripts(customDir?: string): string[] {
  const root = customDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  collectJsonl(root, found);
  return found.sort();
}

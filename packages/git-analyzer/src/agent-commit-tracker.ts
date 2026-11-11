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

const SUBJECT_PREFIX = "[AgentDock]";
const MAX_SUBJECT_LENGTH = 72;
const PATH_MASK = "[PATH]";

const POSIX_SENSITIVE_ROOTS = new Set([
  "home",
  "Users",
  "root",
  "etc",
  "var",
  "usr",
  "opt",
  "tmp",
  "mnt",
  "private",
  "Volumes",
]);
const HOME_ROOTS = new Set(["home", "users"]);
const LEADING_WRAPPERS = new Set(["(", "[", "{", "<", '"', "'", "`"]);
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", '"', "'", "`"]);

interface AbsolutePath {
  segments: string[];
  rootSegments: number;
  endsWithSeparator: boolean;
}

function splitSegments(body: string): string[] {
  return body.split(/[\\/]+/).filter(Boolean);
}

function parseAbsolutePath(candidate: string): AbsolutePath | null {
  if (candidate.includes("://")) {
    return null;
  }
  const endsWithSeparator = /[\\/]$/.test(candidate);

  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    return { segments: splitSegments(candidate.slice(3)), rootSegments: 0, endsWithSeparator };
  }
  if (/^\\\\[^\\/\s]/.test(candidate)) {
    // A UNC path's server and share names are part of its root.
    return { segments: splitSegments(candidate.slice(2)), rootSegments: 2, endsWithSeparator };
  }
  if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    const segments = splitSegments(candidate);
    if (segments.length > 0 && POSIX_SENSITIVE_ROOTS.has(segments[0])) {
      return { segments, rootSegments: 0, endsWithSeparator };
    }
  }
  return null;
}

function maskPath(path: AbsolutePath): string {
  const { segments, rootSegments, endsWithSeparator } = path;
  if (endsWithSeparator || segments.length <= rootSegments) {
    return PATH_MASK;
  }
  // The segment right under a home root is a user name, so it is never revealed.
  if (segments.length === 2 && HOME_ROOTS.has(segments[0].toLowerCase())) {
    return PATH_MASK;
  }
  return `${PATH_MASK}/${segments[segments.length - 1]}`;
}

function maskToken(token: string): string {
  let start = 0;
  while (start < token.length && LEADING_WRAPPERS.has(token[start])) {
    start++;
  }
  let end = token.length;
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1])) {
    end--;
  }

  const prefix = token.slice(0, start);
  const suffix = token.slice(end);
  let core = token.slice(start, end);
  let assignment = "";

  const equalsAt = core.indexOf("=");
  if (equalsAt >= 0 && !core.includes("://")) {
    assignment = core.slice(0, equalsAt + 1);
    core = core.slice(equalsAt + 1);
  }

  const parsed = parseAbsolutePath(core);
  if (!parsed) {
    return token;
  }
  return `${prefix}${assignment}${maskPath(parsed)}${suffix}`;
}

export function maskAbsolutePaths(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (part === "" || /^\s+$/.test(part) ? part : maskToken(part)))
    .join("");
}

function buildSubject(subject: string): string {
  const trimmed = subject.trim();
  const line = trimmed.startsWith(SUBJECT_PREFIX) ? trimmed : `${SUBJECT_PREFIX} ${trimmed}`;
  if (line.length <= MAX_SUBJECT_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_SUBJECT_LENGTH - 3).trimEnd()}...`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildAgentCommitMessage(params: BuildCommitMessageParams): string {
  const { metadata } = params;
  const lines: string[] = [buildSubject(params.subject), ""];

  const summary = params.summary?.trim();
  if (summary) {
    lines.push(maskAbsolutePaths(summary), "");
  }

  lines.push(AGENT_COMMIT_HEADER);
  lines.push(`agent_id: ${singleLine(metadata.agentId)}`);
  if (metadata.agentType) lines.push(`agent_type: ${singleLine(metadata.agentType)}`);
  if (typeof metadata.turn === "number") lines.push(`turn: ${metadata.turn}`);
  if (metadata.modelName) lines.push(`model: ${singleLine(metadata.modelName)}`);
  if (typeof metadata.tokensInput === "number") lines.push(`tokens_input: ${metadata.tokensInput}`);
  if (typeof metadata.tokensOutput === "number") lines.push(`tokens_output: ${metadata.tokensOutput}`);
  if (typeof metadata.costUsd === "number") lines.push(`cost_usd: $${metadata.costUsd.toFixed(4)}`);
  if (metadata.toolsUsed && metadata.toolsUsed.length > 0) {
    lines.push(`tools_used: ${metadata.toolsUsed.map(singleLine).join(", ")}`);
  }
  if (metadata.verifiedCriteria && metadata.verifiedCriteria.length > 0) {
    lines.push(`verified_criteria: ${metadata.verifiedCriteria.map(singleLine).join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

function parseNumber(value: string): number | undefined {
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) ? parsed : undefined;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseAgentCommitTrailers(commitBody: string): Partial<AgentCommitMetadata> | null {
  const lines = commitBody.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === AGENT_COMMIT_HEADER);
  if (headerIndex < 0) {
    return null;
  }

  const result: Partial<AgentCommitMetadata> = {};
  for (const raw of lines.slice(headerIndex + 1)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colonAt = line.indexOf(":");
    if (colonAt <= 0) continue;

    const key = line.slice(0, colonAt).trim().toLowerCase();
    const value = line.slice(colonAt + 1).trim();
    switch (key) {
      case "agent_id":
        result.agentId = value;
        break;
      case "agent_type":
        result.agentType = value;
        break;
      case "turn": {
        const turn = parseNumber(value);
        if (turn !== undefined) result.turn = turn;
        break;
      }
      case "model":
        result.modelName = value;
        break;
      case "tokens_input": {
        const tokens = parseNumber(value);
        if (tokens !== undefined) result.tokensInput = tokens;
        break;
      }
      case "tokens_output": {
        const tokens = parseNumber(value);
        if (tokens !== undefined) result.tokensOutput = tokens;
        break;
      }
      case "cost_usd": {
        const cost = parseNumber(value.replace(/^\$/, ""));
        if (cost !== undefined) result.costUsd = cost;
        break;
      }
      case "tools_used":
        result.toolsUsed = parseList(value);
        break;
      case "verified_criteria":
        result.verifiedCriteria = parseList(value);
        break;
    }
  }
  return result;
}

export function commitAgentTurn(params: {
  cwd: string;
  subject: string;
  summary?: string;
  metadata: AgentCommitMetadata;
}): string {
  const message = buildAgentCommitMessage({
    subject: params.subject,
    summary: params.summary,
    metadata: params.metadata,
  });
  const options = {
    cwd: params.cwd,
    encoding: "utf8" as const,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };

  execFileSync("git", ["add", "--all"], options);
  // The default cleanup mode drops lines starting with "#", which would delete the metadata header.
  execFileSync("git", ["commit", "--cleanup=whitespace", "--file", "-"], { ...options, input: message });
  return execFileSync("git", ["rev-parse", "HEAD"], options).trim();
}

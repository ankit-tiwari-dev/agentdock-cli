/**
 * Multi-CLI tool canonicalization engine.
 * Unifies diverse tool naming conventions (Claude, Codex, Cursor, OpenCode, Antigravity, Copilot, Goose)
 * into standard canonical verbs for deterministic policy evaluation.
 */

export type CanonicalToolVerb =
  | "shell_execute"
  | "file_write"
  | "file_edit"
  | "file_read"
  | "file_list"
  | "web_fetch"
  | "unknown";

export interface CanonicalToolInvocation {
  originalName: string;
  canonicalVerb: CanonicalToolVerb;
  command?: string;
  filePath?: string;
  content?: string;
  normalizedParams: Record<string, unknown>;
}

const TOOL_MAPPINGS: Record<string, CanonicalToolVerb> = {
  // Shell execution
  bash: "shell_execute",
  sh: "shell_execute",
  shell: "shell_execute",
  run_command: "shell_execute",
  execute_command: "shell_execute",
  exec: "shell_execute",
  terminal: "shell_execute",
  run: "shell_execute",

  // File write (create / overwrite)
  write: "file_write",
  write_file: "file_write",
  file_create: "file_write",
  create: "file_write",
  create_file: "file_write",

  // File edit (diff / update)
  edit: "file_edit",
  edit_file: "file_edit",
  str_replace_editor: "file_edit",
  file_edit: "file_edit",
  modify: "file_edit",

  // File read
  read: "file_read",
  read_file: "file_read",
  view: "file_read",
  view_file: "file_read",
  file_read: "file_read",

  // File search / listing
  glob: "file_list",
  grep: "file_list",
  find: "file_list",
  ls: "file_list",

  // Web access
  webfetch: "web_fetch",
  web_fetch: "web_fetch",
  curl: "web_fetch",
  search_web: "web_fetch",
};

export function canonicalizeToolName(rawToolName?: string): CanonicalToolVerb {
  if (!rawToolName) return "unknown";
  const normalized = rawToolName.trim().toLowerCase();
  return TOOL_MAPPINGS[normalized] ?? "unknown";
}

export function canonicalizeToolInput(
  toolName: string,
  rawInput: Record<string, unknown> | string | undefined,
): CanonicalToolInvocation {
  const canonicalVerb = canonicalizeToolName(toolName);
  const normalizedParams: Record<string, unknown> = {};

  if (!rawInput) {
    return {
      originalName: toolName,
      canonicalVerb,
      normalizedParams,
    };
  }

  // Handle raw string input (often shell command string)
  if (typeof rawInput === "string") {
    return {
      originalName: toolName,
      canonicalVerb,
      command: canonicalVerb === "shell_execute" ? rawInput : undefined,
      filePath: canonicalVerb === "file_read" ? rawInput : undefined,
      normalizedParams: { raw: rawInput },
    };
  }

  // Copy parameters
  for (const [k, v] of Object.entries(rawInput)) {
    normalizedParams[k] = v;
  }

  // Extract command across all known schemas
  let command: string | undefined;
  for (const key of ["command", "cmd", "CommandLine", "script", "code"]) {
    if (typeof rawInput[key] === "string") {
      command = rawInput[key] as string;
      break;
    }
  }

  // Extract filePath across all known schemas
  let filePath: string | undefined;
  for (const key of ["path", "Path", "filePath", "file_path", "target_file", "file"]) {
    if (typeof rawInput[key] === "string") {
      filePath = rawInput[key] as string;
      break;
    }
  }

  // Extract content across all known schemas
  let content: string | undefined;
  for (const key of ["content", "Content", "replacement", "new_content", "patch", "text"]) {
    if (typeof rawInput[key] === "string") {
      content = rawInput[key] as string;
      break;
    }
  }

  return {
    originalName: toolName,
    canonicalVerb,
    command,
    filePath,
    content,
    normalizedParams,
  };
}

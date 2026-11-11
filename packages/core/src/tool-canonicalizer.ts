/**
 * Maps each agent's tool vocabulary (Claude Code, Codex, OpenCode, Cursor, Gemini, Copilot, Goose)
 * onto a small set of canonical verbs so rules are written once.
 */

export type CanonicalToolVerb =
  "shell_execute" | "file_write" | "file_edit" | "file_read" | "file_list" | "web_fetch" | "subagent" | "unknown";

export interface CanonicalToolInvocation {
  originalName: string;
  canonicalVerb: CanonicalToolVerb;
  command?: string;
  filePath?: string;
  /** Every file a call touches; a single patch can edit several. */
  filePaths: string[];
  content?: string;
  normalizedParams: Record<string, unknown>;
}

const TOOL_MAPPINGS: Record<string, CanonicalToolVerb> = {
  bash: "shell_execute",
  sh: "shell_execute",
  shell: "shell_execute",
  local_shell: "shell_execute",
  container_exec: "shell_execute",
  run_command: "shell_execute",
  run_shell_command: "shell_execute",
  run_terminal_cmd: "shell_execute",
  execute_command: "shell_execute",
  exec: "shell_execute",
  exec_command: "shell_execute",
  terminal: "shell_execute",
  run: "shell_execute",
  powershell: "shell_execute",

  write: "file_write",
  write_file: "file_write",
  file_create: "file_write",
  create: "file_write",
  create_file: "file_write",

  edit: "file_edit",
  multiedit: "file_edit",
  notebookedit: "file_edit",
  edit_file: "file_edit",
  str_replace_editor: "file_edit",
  str_replace_based_edit_tool: "file_edit",
  replace: "file_edit",
  apply_patch: "file_edit",
  patch: "file_edit",
  file_edit: "file_edit",
  modify: "file_edit",
  // There is no separate delete verb: deleting or moving a file is an edit, so the file rules
  // (protected tests, secrets, control plane files) apply to it.
  delete_file: "file_edit",
  move_file: "file_edit",

  read: "file_read",
  read_file: "file_read",
  read_many_files: "file_read",
  view: "file_read",
  view_file: "file_read",
  file_read: "file_read",

  glob: "file_list",
  grep: "file_list",
  find: "file_list",
  ls: "file_list",
  list: "file_list",
  list_dir: "file_list",
  list_directory: "file_list",
  search_file_content: "file_list",
  codebase_search: "file_list",

  webfetch: "web_fetch",
  web_fetch: "web_fetch",
  websearch: "web_fetch",
  web_search: "web_fetch",
  google_web_search: "web_fetch",
  curl: "web_fetch",
  search_web: "web_fetch",

  task: "subagent",
  agent: "subagent",
};

// MCP tools are named `mcp__<server>__<tool>`. Only file-changing tools are mapped, so an MCP tool
// that happens to be called `run` or `exec` is not treated as a shell.
const MCP_FILE_TOOLS = new Set(["write_file", "create_file", "edit_file", "delete_file", "move_file"]);

/**
 * The `<tool>` of `mcp__<server>__<tool>`, split at the last `__` as `/^mcp__.+__([a-z0-9_]+)$/` does, or
 * undefined for any other name. Done by hand because that regex is quadratic on a name with many `__`.
 */
function mcpToolName(name: string): string | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  // The last `__` that still leaves a tool name after it, the one the greedy `.+` picks. Any earlier `__` gives
  // a longer tool name ending in this one, so it can only succeed where this one does: no need to try them.
  const split = name.lastIndexOf("__", name.length - 3);
  if (split < "mcp__".length + 1) return undefined;
  const tool = name.slice(split + 2);
  if (!/^[a-z0-9_]+$/.test(tool) || /[\n\r\u2028\u2029]/.test(name.slice("mcp__".length, split))) return undefined;
  return tool;
}

export function canonicalizeToolName(rawToolName?: string): CanonicalToolVerb {
  if (!rawToolName) return "unknown";
  const normalized = rawToolName.trim().toLowerCase();
  const mcp = mcpToolName(normalized);
  if (mcp !== undefined) return MCP_FILE_TOOLS.has(mcp) ? (TOOL_MAPPINGS[mcp] ?? "unknown") : "unknown";
  return TOOL_MAPPINGS[normalized] ?? "unknown";
}

/** True when two tool names refer to the same kind of action (e.g. `Bash` and `run_command`). */
export function sameToolKind(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const ca = canonicalizeToolName(a);
  return ca !== "unknown" && ca === canonicalizeToolName(b);
}

const COMMAND_KEYS = ["command", "cmd", "CommandLine", "script", "code"];
const PATH_KEYS = ["file_path", "filePath", "path", "Path", "notebook_path", "target_file", "file", "absolute_path"];
const CONTENT_KEYS = [
  "content",
  "Content",
  "new_string",
  "replacement",
  "new_content",
  "patch",
  // OpenCode `patch`
  "patchText",
  // NotebookEdit
  "new_source",
  "input",
  "text",
];
// Second paths of a move (`move_file`): both ends are file targets.
const MOVE_PATH_KEYS = ["source", "destination"];

/** Codex sends `["bash", "-lc", "<script>"]`; the script is what the shell runs. */
function commandFromValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    const parts = value as string[];
    const flagIndex = parts.findIndex((p) => p === "-c" || p === "-lc" || p === "/c" || p === "-Command");
    if (flagIndex !== -1 && parts[flagIndex + 1] !== undefined) return parts.slice(flagIndex + 1).join(" ");
    return parts.join(" ");
  }
  return undefined;
}

/** Files named by an apply_patch envelope (`*** Update File: src/a.ts`). */
export function filesFromPatch(patch: string): string[] {
  const files: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    const f = (m[1] ?? m[2] ?? "").trim();
    if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

export function canonicalizeToolInput(
  toolName: string,
  rawInput: Record<string, unknown> | string | undefined,
): CanonicalToolInvocation {
  const canonicalVerb = canonicalizeToolName(toolName);
  const normalizedParams: Record<string, unknown> = {};

  if (!rawInput) {
    return { originalName: toolName, canonicalVerb, filePaths: [], normalizedParams };
  }

  if (typeof rawInput === "string") {
    const patchFiles = filesFromPatch(rawInput);
    return {
      originalName: toolName,
      canonicalVerb,
      command: canonicalVerb === "shell_execute" ? rawInput : undefined,
      filePath: canonicalVerb === "file_read" ? rawInput : patchFiles[0],
      filePaths: canonicalVerb === "file_read" ? [rawInput] : patchFiles,
      content: canonicalVerb === "file_edit" ? rawInput : undefined,
      normalizedParams: { raw: rawInput },
    };
  }

  for (const [k, v] of Object.entries(rawInput)) {
    normalizedParams[k] = v;
  }

  let command: string | undefined;
  for (const key of COMMAND_KEYS) {
    command = commandFromValue(rawInput[key]);
    if (command !== undefined) break;
  }

  const filePaths: string[] = [];
  for (const key of PATH_KEYS) {
    const v = rawInput[key];
    if (typeof v === "string" && v) {
      filePaths.push(v);
      break;
    }
  }
  if (Array.isArray(rawInput.paths)) {
    for (const p of rawInput.paths) if (typeof p === "string") filePaths.push(p);
  }
  if (canonicalVerb === "file_write" || canonicalVerb === "file_edit") {
    for (const key of MOVE_PATH_KEYS) {
      const v = rawInput[key];
      if (typeof v === "string" && v && !filePaths.includes(v)) filePaths.push(v);
    }
  }

  let content: string | undefined;
  for (const key of CONTENT_KEYS) {
    if (typeof rawInput[key] === "string") {
      content = rawInput[key] as string;
      break;
    }
  }
  // MultiEdit sends `edits: [{ old_string, new_string }, ...]`; the new strings are the content.
  if (content === undefined && Array.isArray(rawInput.edits)) {
    const parts = (rawInput.edits as unknown[])
      .map((e) => (typeof e === "object" && e !== null ? (e as Record<string, unknown>).new_string : undefined))
      .filter((s): s is string => typeof s === "string");
    if (parts.length > 0) content = parts.join("\n");
  }

  // An OpenCode patchText has `*** Update File:` lines without a `*** Begin Patch` line.
  if (content && (/^\*\*\* Begin Patch/m.test(content) || typeof rawInput.patchText === "string")) {
    for (const f of filesFromPatch(content)) if (!filePaths.includes(f)) filePaths.push(f);
  }
  if (command && /\*\*\* Begin Patch/.test(command)) {
    for (const f of filesFromPatch(command)) if (!filePaths.includes(f)) filePaths.push(f);
  }

  return {
    originalName: toolName,
    canonicalVerb,
    command,
    filePath: filePaths[0],
    filePaths,
    content,
    normalizedParams,
  };
}

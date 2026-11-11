import type { AgentHookPayload, AgentKind, HookEventName } from "./ipc.ts";

const EVENT_ALIASES: Record<string, HookEventName> = {
  pretooluse: "PreToolUse",
  pre_tool_use: "PreToolUse",
  beforetool: "PreToolUse",
  posttooluse: "PostToolUse",
  post_tool_use: "PostToolUse",
  aftertool: "PostToolUse",
  userpromptsubmit: "UserPromptSubmit",
  user_prompt_submit: "UserPromptSubmit",
  beforesubmitprompt: "UserPromptSubmit",
  stop: "Stop",
  subagentstop: "SubagentStop",
  subagent_stop: "SubagentStop",
  sessionstart: "SessionStart",
  session_start: "SessionStart",
  sessionend: "SessionEnd",
  session_end: "SessionEnd",
  precompact: "PreCompact",
  pre_compact: "PreCompact",
  precompress: "PreCompact",
  notification: "Notification",
};

export function normalizeEventName(raw: string | undefined): HookEventName | undefined {
  if (!raw) return undefined;
  return EVENT_ALIASES[raw.replace(/[-\s]/g, "").toLowerCase()] ?? EVENT_ALIASES[raw.toLowerCase()];
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asInput(v: unknown): Record<string, unknown> | string | undefined {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // A plain string input (e.g. a raw shell command) is valid as-is.
    }
    return v;
  }
  if (v && typeof v === "object") return v as Record<string, unknown>;
  return undefined;
}

function guessAgent(raw: Record<string, unknown>, explicit?: string): AgentKind {
  const e = explicit?.toLowerCase();
  if (e === "claude" || e === "claude-code") return "claude-code";
  if (e === "codex" || e === "opencode" || e === "cursor" || e === "gemini") return e;
  if (typeof raw.hook_event_name === "string" && /_/.test(raw.hook_event_name)) return "codex";
  if (raw.turn_id !== undefined) return "codex";
  if (raw.cursor_version !== undefined || raw.conversation_id !== undefined) return "cursor";
  if (raw.transcript_path !== undefined || raw.session_id !== undefined) return "claude-code";
  return "custom";
}

/**
 * Reads a PostToolUse response and decides whether the tool call failed.
 * The signature groups "the same failure" so the loop breaker can count repeats.
 */
export function detectToolFailure(
  toolName: string | undefined,
  response: Record<string, unknown> | string | undefined,
): { failed: boolean; signature?: string } {
  if (response === undefined) return { failed: false };
  if (typeof response === "string") {
    const failed = /^(error|failed|exception)\b|\bexit code [1-9]/i.test(response.trim());
    return failed ? { failed, signature: `${toolName}:${firstLine(response)}` } : { failed: false };
  }
  const r = response;
  const exit = pick(r, "exit_code", "exitCode", "returncode", "status_code");
  const errorField = pick(r, "error", "stderr_error");
  const isError = r.is_error === true || r.isError === true || r.success === false || r.interrupted === true;
  const exitFailed = typeof exit === "number" && exit !== 0;
  const failed = isError || exitFailed || (typeof errorField === "string" && errorField.length > 0);
  if (!failed) return { failed: false };
  const detail = asString(errorField) ?? asString(r.stderr) ?? asString(r.output) ?? asString(r.stdout) ?? "";
  return { failed: true, signature: `${toolName}:${firstLine(detail)}` };
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, 160);
}

/**
 * Turns whatever an agent wrote to the hook's stdin into one payload shape.
 * Claude Code and Codex send snake_case (`tool_name`, `tool_input`, `session_id`);
 * older internal callers send camelCase. Both are accepted.
 */
export function normalizeHookPayload(
  cliEventName: string | undefined,
  raw: Record<string, unknown>,
  fallbackCwd: string,
  explicitAgent?: string,
): AgentHookPayload {
  const eventFromBody = normalizeEventName(asString(pick(raw, "hook_event_name", "hookEventName", "event")));
  const hookEventName = normalizeEventName(cliEventName) ?? eventFromBody ?? "PreToolUse";

  const stopActive = pick(raw, "stop_hook_active", "stopHookActive");
  const control = asString(raw.control);

  return {
    hookEventName,
    cwd: asString(pick(raw, "cwd", "workspace_root", "directory")) ?? fallbackCwd,
    sessionId: asString(pick(raw, "session_id", "sessionId", "sessionID", "conversation_id")),
    toolName: asString(pick(raw, "tool_name", "toolName", "tool")),
    toolInput: asInput(pick(raw, "tool_input", "toolInput", "args", "input")),
    toolResponse: asInput(pick(raw, "tool_response", "toolResponse", "tool_output", "output", "result")),
    prompt: asString(pick(raw, "prompt", "user_prompt", "message")),
    transcriptPath: asString(pick(raw, "transcript_path", "transcriptPath")),
    permissionMode: asString(pick(raw, "permission_mode", "permissionMode")),
    source: asString(pick(raw, "source", "trigger", "reason")),
    stopHookActive: stopActive === true || stopActive === "true",
    subagentId: asString(pick(raw, "agent_id", "agentId", "subagent_id")),
    agent: guessAgent(raw, explicitAgent),
    control: control === "shutdown" || control === "ping" ? control : undefined,
  };
}

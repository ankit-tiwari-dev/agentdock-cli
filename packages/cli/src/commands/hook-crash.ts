import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHookPayload, AgentType, AuditEvent } from "../../../core/src/index.ts";
import { DEFAULT_SESSION_ID, auditDbPath, ctrlplaneDir } from "../../../core/src/index.ts";
import { redactObject, redactSecrets } from "../../../storage/src/redactor.ts";

// What the hook does when it crashes (D-18): only the developer can get past it, by pausing.

export const CRASH_HINT = "Run 'ctrlplane pause' in your terminal to temporarily bypass, or report this bug.";
export const CRASH_RULE_ID = "CRASH-WHILE-PAUSED";

const AGENTDOCK_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export interface CrashContext {
  payload: AgentHookPayload | undefined;
  raw: Record<string, unknown>;
  projectRoot: string;
  error: unknown;
}

export type CrashRow = Omit<AuditEvent, "id" | "sequenceNum">;

export interface CrashDeps {
  redactObject: <T>(value: T) => T;
  redactSecrets: (text: string) => { sanitized: string };
  /** Writes the row to the project's audit log; replaced in tests to simulate a log that cannot be written. */
  writeRow: (projectRoot: string, session: { id: string; agent: string }, row: CrashRow) => Promise<void>;
}

const DEFAULT_DEPS: CrashDeps = { redactObject, redactSecrets, writeRow: writeCrashRow };

export function errorType(error: unknown): string {
  try {
    if (error instanceof Error) return error.constructor?.name || error.name || "Error";
    return typeof error;
  } catch {
    return "unknown";
  }
}

/** The error's message with secrets redacted; only its type when the redactor itself fails. */
export function safeMessage(error: unknown, deps: Pick<CrashDeps, "redactSecrets"> = DEFAULT_DEPS): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return `${errorType(error)}: ${deps.redactSecrets(message).sanitized}`;
  } catch {
    return errorType(error);
  }
}

/** Stack frames inside AgentDock only, as paths relative to it: nothing from the project, the home folder or a command. */
export function agentdockFrames(error: unknown, root = AGENTDOCK_ROOT): string[] {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const m = /^\s+at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    let file = m[2];
    try {
      if (file.startsWith("file:")) file = fileURLToPath(file);
    } catch {
      continue;
    }
    const rel = relative(root, file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const fn = m[1] && /^[\w$.<> ]+$/.test(m[1]) ? `${m[1]} ` : "";
    frames.push(`at ${fn}(${rel.split(sep).join("/")}:${m[3]}:${m[4]})`);
  }
  return frames.slice(0, 10);
}

function toolNameOf(ctx: CrashContext): string | undefined {
  const name = ctx.payload?.toolName ?? ctx.raw.tool_name ?? ctx.raw.toolName;
  return typeof name === "string" ? name.slice(0, 200) : undefined;
}

function rawInput(ctx: CrashContext): unknown {
  return ctx.payload?.toolInput ?? ctx.raw.tool_input ?? ctx.raw.toolInput;
}

function fingerprint(value: unknown): { bytes: number; sha256: string } {
  const text = JSON.stringify(value ?? null) ?? "null";
  return { bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}

/**
 * Records a PreToolUse call that went through only because supervision was paused when the hook crashed: verdict
 * ALLOW, rule CRASH-WHILE-PAUSED. Payload and error are redacted; if the redactor throws, only the tool name, size,
 * hash and error type are kept. If the row cannot be written, a single stderr line carries the same safe fields.
 */
export async function recordCrashWhilePaused(
  ctx: CrashContext,
  overrides: Partial<CrashDeps> = {},
): Promise<{ recorded: boolean; stderr?: string }> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const toolName = toolNameOf(ctx);
  const input = rawInput(ctx);
  const print = fingerprint(input);
  const type = errorType(ctx.error);
  let toolInput: Record<string, unknown>;
  let reason: string;
  try {
    const redacted = deps.redactObject(input ?? null);
    const frames = agentdockFrames(ctx.error).map((f) => deps.redactSecrets(f).sanitized);
    toolInput = redacted && typeof redacted === "object" ? (redacted as Record<string, unknown>) : { value: redacted };
    reason = [`Hook crashed while supervision was paused. ${safeMessage(ctx.error, deps)}`, ...frames].join("\n");
  } catch {
    toolInput = { ...print, redacted: "redactor failed; payload not stored" };
    reason = `Hook crashed while supervision was paused. ${type}`;
  }

  const sessionId = ctx.payload?.sessionId ?? (typeof ctx.raw.session_id === "string" ? ctx.raw.session_id : undefined);
  const row: CrashRow = {
    sessionId: sessionId ?? DEFAULT_SESSION_ID,
    eventType: "pre_tool",
    toolName,
    toolInput,
    policyVerdict: "ALLOW",
    policyReason: reason,
    ruleId: CRASH_RULE_ID,
    executionDurationMs: 0,
    createdAt: Date.now(),
  };
  try {
    await deps.writeRow(ctx.projectRoot, { id: row.sessionId, agent: ctx.payload?.agent ?? "custom" }, row);
    return { recorded: true };
  } catch {
    return {
      recorded: false,
      stderr: `[ctrlplane warning] could not record the crash: tool=${toolName ?? "unknown"} bytes=${print.bytes} sha256=${print.sha256} error=${type}`,
    };
  }
}

async function writeCrashRow(
  projectRoot: string,
  session: { id: string; agent: string },
  row: CrashRow,
): Promise<void> {
  if (!existsSync(ctrlplaneDir(projectRoot))) throw new Error("not a ctrlplane project");
  const [{ StorageEngine }, { auditEventId }] = await Promise.all([
    import("../../../storage/src/index.ts"),
    import("../../../daemon/src/audit-record.ts"),
  ]);
  const storage = new StorageEngine(auditDbPath(projectRoot));
  try {
    storage.ensureSession({
      id: session.id,
      agentType: session.agent as AgentType,
      projectPath: projectRoot,
      gitBranch: "unknown",
      baseCommitSha: "0000000000000000000000000000000000000000",
      status: "active",
      startedAt: row.createdAt,
    });
    storage.appendEvent(row, auditEventId);
  } finally {
    storage.close();
  }
}

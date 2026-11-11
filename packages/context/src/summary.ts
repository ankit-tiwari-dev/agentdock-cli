import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { canonicalizeToolInput, type AuditEvent } from "../../core/src/index.ts";
import { toProjectPath } from "../../policy-engine/src/glob.ts";
import { cleanPrompt, inertLine } from "./intent.ts";

export interface SessionDigest {
  sessionId: string;
  toolCalls: number;
  firstAt?: number;
  lastAt?: number;
  intents: string[];
  filesChanged: string[];
  commands: { command: string; count: number }[];
  interventions: { reason: string; decision: string; count: number }[];
  /** MCP servers, skills and subagent types the session actually called, read from tool names and inputs. */
  capabilitiesUsed: string[];
}

/** `mcp__github__create_issue` → `mcp github`; `Skill {skill}` → `skill x`; `Task/Agent {subagent_type}` → `agent x`. */
export function capabilityUsed(toolName: string, input: unknown): string | null {
  const mcp = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (mcp) return `mcp ${inertLine(mcp[1])}`;
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (toolName === "Skill" && typeof args.skill === "string") return `skill ${inertLine(args.skill)}`;
  if ((toolName === "Task" || toolName === "Agent") && typeof args.subagent_type === "string")
    return `agent ${inertLine(args.subagent_type)}`;
  return null;
}

const MAX_FILES = 15;
const MAX_COMMANDS = 8;

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** What happened in a session, computed from its audit events alone (no model involved). */
export function digestSession(sessionId: string, events: AuditEvent[], projectRoot: string): SessionDigest {
  const digest: SessionDigest = {
    sessionId,
    toolCalls: 0,
    intents: [],
    filesChanged: [],
    commands: [],
    interventions: [],
    capabilitiesUsed: [],
  };
  const commandIndex = new Map<string, number>();
  const interventionIndex = new Map<string, number>();

  for (const e of events) {
    digest.firstAt ??= e.createdAt;
    digest.lastAt = e.createdAt;

    if (e.eventType === "user_prompt") {
      const input = e.toolInput && typeof e.toolInput === "object" ? e.toolInput : undefined;
      const text = cleanPrompt(typeof input?.prompt === "string" ? input.prompt : undefined, 200);
      if (text) digest.intents.push(text);
      continue;
    }
    if (e.eventType !== "pre_tool" || !e.toolName) continue;
    digest.toolCalls++;

    if (e.policyVerdict === "DENY" || e.policyVerdict === "REQUIRE_MANUAL_APPROVAL") {
      const reason = shorten(inertLine((e.policyReason ?? "").replace(/\s*\(Triggered by[^)]*\)\s*$/, "")), 140);
      const key = `${e.policyVerdict}|${reason}`;
      const i = interventionIndex.get(key);
      if (i === undefined) {
        interventionIndex.set(key, digest.interventions.length);
        digest.interventions.push({ reason, decision: e.policyVerdict === "DENY" ? "blocked" : "asked", count: 1 });
      } else digest.interventions[i].count++;
      if (e.policyVerdict === "DENY") continue;
    }

    // Counted past the DENY check: a blocked call did not use the capability.
    const used = capabilityUsed(e.toolName, e.toolInput);
    if (used && !digest.capabilitiesUsed.includes(used)) digest.capabilitiesUsed.push(used);

    const call = canonicalizeToolInput(e.toolName, e.toolInput);
    if (call.canonicalVerb === "file_edit" || call.canonicalVerb === "file_write") {
      for (const f of call.filePaths) {
        const rel = inertLine(toProjectPath(f, projectRoot));
        if (!digest.filesChanged.includes(rel)) digest.filesChanged.push(rel);
      }
    } else if (call.canonicalVerb === "shell_execute" && call.command) {
      const cmd = call.command.replace(/\s+/g, " ").trim().slice(0, 100);
      const i = commandIndex.get(cmd);
      if (i === undefined) {
        commandIndex.set(cmd, digest.commands.length);
        digest.commands.push({ command: cmd, count: 1 });
      } else digest.commands[i].count++;
    }
  }
  return digest;
}

export function isEmptyDigest(d: SessionDigest): boolean {
  return d.toolCalls === 0 && d.intents.length === 0;
}

export function renderDigest(d: SessionDigest): string {
  const lines: string[] = [];
  const when = d.firstAt ? `${new Date(d.firstAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "unknown time";
  lines.push(`Session ${d.sessionId.slice(0, 12)} (${when}, ${d.toolCalls} tool calls)`);
  if (d.intents.length) {
    lines.push("Asked for:");
    for (const i of d.intents.slice(-3)) lines.push(`- ${i}`);
  }
  if (d.filesChanged.length) {
    const more = d.filesChanged.length > MAX_FILES ? ` (+${d.filesChanged.length - MAX_FILES} more)` : "";
    lines.push(`Files changed: ${d.filesChanged.slice(0, MAX_FILES).join(", ")}${more}`);
  }
  if (d.commands.length) {
    lines.push(
      `Commands: ${d.commands
        .slice(0, MAX_COMMANDS)
        .map((c) => (c.count > 1 ? `${c.command} (×${c.count})` : c.command))
        .join("; ")}`,
    );
  }
  if (d.capabilitiesUsed.length) lines.push(`Used: ${d.capabilitiesUsed.slice(0, 10).join(", ")}`);
  if (d.interventions.length) {
    lines.push("Supervisor stepped in:");
    for (const i of d.interventions.slice(0, 5))
      lines.push(`- ${i.decision}${i.count > 1 ? ` ×${i.count}` : ""}: ${i.reason}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Optional model-written summary through the developer's local `claude` CLI.

export type SummaryRunner = (input: string, systemPrompt: string, timeoutMs: number) => Promise<string>;

const SYSTEM_PROMPT =
  "You summarise a coding-agent session for the next session. Reply with at most 10 short bullet lines: goal, what was done, what is unfinished, what to watch out for. No preamble, no closing remarks.";

/**
 * Runs `claude -p` with no tools, no MCP servers and no settings (so no hooks fire), from the temp
 * directory so no project instructions load. The digest goes in on stdin.
 */
export const claudeCliRunner: SummaryRunner = (input, systemPrompt, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.env.CTRLPLANE_CLAUDE_BIN ?? "claude",
      ["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", systemPrompt],
      {
        cwd: tmpdir(),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, CTRLPLANE_NESTED: "1" },
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
    child.stdin?.end(input);
  });

const PREAMBLE = /^(?:here(?:'s| is)|sure|certainly|okay|ok)\b[^\n]*:\s*\n/i;

/** Model summary of a digest, or null when disabled, failed, timed out or returned something unusable. */
export async function aiSummarize(
  digestText: string,
  run: SummaryRunner = claudeCliRunner,
  timeoutMs = 60_000,
): Promise<string | null> {
  try {
    let out = (await run(digestText, SYSTEM_PROMPT, timeoutMs)).trim();
    out = out.replace(PREAMBLE, "").trim();
    if (!out || out.length > 4000 || /^error\b/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

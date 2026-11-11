import { execFileSync } from "node:child_process";
import type { StorageEngine } from "../../storage/src/index.ts";

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * A note for whoever picks the work up next (a new session, another agent, the developer tomorrow):
 * branch, uncommitted files, the latest session summary and an optional free-text note.
 */
export function writeHandoff(storage: StorageEngine, projectRoot: string, options: { note?: string; sessionId?: string } = {}): string {
  const lines: string[] = [];
  const branch = git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(projectRoot, ["log", "-1", "--format=%h %s"]);
  if (branch) lines.push(`Branch: ${branch}${head ? ` at ${head}` : ""}`);

  const status = git(projectRoot, ["status", "--porcelain"]);
  if (status) {
    const files = status.split(/\r?\n/).filter(Boolean);
    lines.push(`Uncommitted: ${files.slice(0, 15).map((l) => l.slice(3)).join(", ")}${files.length > 15 ? ` (+${files.length - 15} more)` : ""}`);
  } else if (status === "") {
    lines.push("Working tree clean.");
  }

  if (options.note?.trim()) lines.push(`Note: ${options.note.trim().slice(0, 1000)}`);

  const summary = storage.listContextEntries("summary", { limit: 1 })[0] ?? storage.listContextEntries("compact", { limit: 1 })[0];
  if (summary) lines.push("", summary.body);

  const body = lines.join("\n").trim() || "No session activity recorded yet.";
  storage.addContextEntry({ sessionId: options.sessionId, kind: "handoff", body });
  return body;
}

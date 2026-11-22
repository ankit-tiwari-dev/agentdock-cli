// Where AgentDock keeps state, and the values more than one package must agree on. ESLint fails on a
// hand-written copy of any of these outside this file (eslint.config.js → "one owner for shared values").
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { HookEventName } from "./ipc.ts";

/** The per-project state folder's name. */
export const CTRLPLANE_DIR = ".ctrlplane";

/** The session id recorded for a payload that names none. */
export const DEFAULT_SESSION_ID = "sess_default";

/** Hook events whose prompt, summary or handoff is recorded as context, by the daemon or by the hook itself. */
export const CONTEXT_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "UserPromptSubmit",
  "SessionStart",
  "PreCompact",
  "Stop",
  "SessionEnd",
]);

export function ctrlplaneDir(projectRoot: string): string {
  return join(projectRoot, CTRLPLANE_DIR);
}

export function auditDbPath(projectRoot: string): string {
  return join(projectRoot, CTRLPLANE_DIR, "audit.db");
}

export function daemonLockPath(projectRoot: string): string {
  return join(projectRoot, CTRLPLANE_DIR, "daemon.lock");
}

export function specPath(projectRoot: string): string {
  return join(projectRoot, CTRLPLANE_DIR, "spec.md");
}

export function pauseStatePath(projectRoot: string): string {
  return join(projectRoot, CTRLPLANE_DIR, "state", "pause.json");
}

export function projectPolicyPath(projectRoot: string, scope: "project" | "local"): string {
  return join(projectRoot, CTRLPLANE_DIR, scope === "local" ? "policies.local.json" : "policies.json");
}

/**
 * The developer's own state folder: `CTRLPLANE_HOME`, or `~/.ctrlplane` when it is unset or empty. A relative value
 * throws, because it would resolve inside the current folder, usually a project the agent can write.
 */
export function ctrlplaneHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const value = env.CTRLPLANE_HOME;
  if (!value) return join(home, CTRLPLANE_DIR);
  if (!isAbsolute(value)) throw new Error(RELATIVE_HOME_MESSAGE);
  return value;
}

/** The error a relative `CTRLPLANE_HOME` raises; supervisor-config.ts repeats it because it imports nothing. */
export const RELATIVE_HOME_MESSAGE =
  "CTRLPLANE_HOME must be an absolute path; a relative one would point inside the current folder. Unset it or give a full path.";

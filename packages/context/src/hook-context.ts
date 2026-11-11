import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentHookPayload } from "../../core/src/index.ts";
import { buildProjectEngine, readPause, type ProjectEngine } from "../../policy-engine/src/index.ts";
import { StorageEngine } from "../../storage/src/index.ts";
import { buildContextPack, type SupervisionState } from "./pack.ts";
import { ContextRecorder } from "./recorder.ts";

export function auditDbPath(projectRoot: string): string {
  return join(projectRoot, ".ctrlplane", "audit.db");
}

export function supervisionState(project: ProjectEngine, projectRoot: string): SupervisionState {
  let enforcing = 0;
  const observing: string[] = [];
  for (const r of project.engine.getRules()) {
    const eff = project.engine.resolveRule(r);
    if (!eff.enabled && !r.alwaysOn) continue;
    if (eff.mode === "observe" && !r.alwaysOn) observing.push(r.id);
    else enforcing++;
  }
  return { enforcing, observing, pausedUntil: readPause(projectRoot)?.until };
}

/** Context pack for a SessionStart hook, read straight from the project's audit database. */
export async function contextForHook(payload: AgentHookPayload, projectRoot: string): Promise<string | undefined> {
  if (payload.hookEventName !== "SessionStart") return undefined;
  const project = await buildProjectEngine(projectRoot).catch(() => null);
  const dbPath = auditDbPath(projectRoot);
  const storage = existsSync(dbPath) ? new StorageEngine(dbPath) : null;
  try {
    return buildContextPack({
      projectRoot,
      storage,
      sessionId: payload.sessionId,
      source: payload.source,
      supervision: project ? supervisionState(project, projectRoot) : undefined,
      maxChars: project?.config.context.maxChars,
    });
  } finally {
    storage?.close();
  }
}

const RECORDED_EVENTS = new Set(["UserPromptSubmit", "SessionStart", "PreCompact", "Stop", "SessionEnd"]);

/** Records context in-process when no daemon is running. Never runs the model summary: the hook process must exit promptly. */
export function recordWithoutDaemon(payload: AgentHookPayload, projectRoot: string): void {
  if (!RECORDED_EVENTS.has(payload.hookEventName) || !existsSync(join(projectRoot, ".ctrlplane"))) return;
  const storage = new StorageEngine(auditDbPath(projectRoot));
  try {
    new ContextRecorder(storage, projectRoot, { allowAsync: false }).record(payload, payload.sessionId ?? "sess_default");
  } finally {
    storage.close();
  }
}

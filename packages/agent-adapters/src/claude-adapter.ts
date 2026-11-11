import { join } from "node:path";
import {
  defaultHookCommand,
  mergeHookGroups,
  readJsonObject,
  stripHookGroups,
  writeJsonIfChanged,
  type HookEventSpec,
} from "./hook-command.ts";

export const CLAUDE_HOOK_EVENTS: HookEventSpec[] = [
  { event: "PreToolUse", matcher: "*", timeoutSeconds: 15 },
  { event: "PostToolUse", matcher: "*", timeoutSeconds: 15 },
  { event: "UserPromptSubmit", timeoutSeconds: 15 },
  { event: "Stop", timeoutSeconds: 120 },
  { event: "SubagentStop", timeoutSeconds: 120 },
  { event: "SessionStart", timeoutSeconds: 30 },
  { event: "SessionEnd", timeoutSeconds: 15 },
  { event: "PreCompact", timeoutSeconds: 90 },
];

/**
 * Installs hooks into `.claude/settings.local.json`: the command holds a machine-specific path,
 * and the local file is the one Claude Code keeps out of version control. Earlier versions wrote
 * a wrong-shaped entry into `settings.json`; those are removed from both files.
 */
export function injectClaudeHooks(
  projectPath: string,
  cliCommand = defaultHookCommand(),
): {
  success: boolean;
  settingsPath: string;
  backupPath?: string;
  addedHooksCount: number;
} {
  const claudeDir = join(projectPath, ".claude");
  const settingsPath = join(claudeDir, "settings.local.json");

  const sharedPath = join(claudeDir, "settings.json");
  const shared = readJsonObject(sharedPath);
  if (shared.raw !== undefined && shared.data.hooks && typeof shared.data.hooks === "object") {
    if (stripHookGroups(shared.data.hooks as Record<string, unknown>) > 0) {
      if (Object.keys(shared.data.hooks as object).length === 0) delete shared.data.hooks;
      writeJsonIfChanged(sharedPath, shared.data, shared.raw);
    }
  }

  const local = readJsonObject(settingsPath);
  const settings = local.data;
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const added = mergeHookGroups(
    settings.hooks as Record<string, unknown>,
    CLAUDE_HOOK_EVENTS,
    (event) => `${cliCommand} ${event}`,
  );
  const written = writeJsonIfChanged(settingsPath, settings, local.raw);

  return {
    success: true,
    settingsPath,
    backupPath: written.backupPath,
    addedHooksCount: added,
  };
}

export function removeClaudeHooks(projectPath: string): number {
  let removed = 0;
  for (const name of ["settings.local.json", "settings.json"]) {
    const path = join(projectPath, ".claude", name);
    const file = readJsonObject(path);
    if (file.raw === undefined || !file.data.hooks || typeof file.data.hooks !== "object") continue;
    const n = stripHookGroups(file.data.hooks as Record<string, unknown>);
    if (n > 0) {
      if (Object.keys(file.data.hooks as object).length === 0) delete file.data.hooks;
      writeJsonIfChanged(path, file.data, file.raw);
      removed += n;
    }
  }
  return removed;
}

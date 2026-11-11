import { join } from "node:path";
import {
  defaultHookCommand,
  mergeHookGroups,
  readJsonObject,
  stripHookGroups,
  writeJsonIfChanged,
  type HookEventSpec,
} from "./hook-command.ts";

export const CODEX_HOOK_EVENTS: HookEventSpec[] = [
  { event: "PreToolUse", matcher: "*", timeoutSeconds: 15 },
  { event: "PostToolUse", matcher: "*", timeoutSeconds: 15 },
  { event: "UserPromptSubmit", timeoutSeconds: 15 },
  { event: "Stop", timeoutSeconds: 120 },
  { event: "SessionStart", timeoutSeconds: 30 },
];

/**
 * Installs hooks into `.codex/hooks.json` using the same `{ Event: [{ matcher, hooks: [...] }] }`
 * shape as Claude Code. Codex only runs a hook after the developer trusts it in the interactive
 * "Review hooks" prompt, so `ctrlplane doctor` reminds about that step.
 */
export function injectCodexHooks(projectPath: string, cliCommand = defaultHookCommand()): {
  success: boolean;
  hooksPath: string;
  backupPath?: string;
  addedHooksCount: number;
} {
  const hooksPath = join(projectPath, ".codex", "hooks.json");
  const file = readJsonObject(hooksPath);
  const config = file.data;

  // Earlier versions wrote a flat array; Codex does not read that shape.
  if (Array.isArray(config.hooks)) config.hooks = {};
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};

  const added = mergeHookGroups(config.hooks as Record<string, unknown>, CODEX_HOOK_EVENTS, (event) => `${cliCommand} ${event} --agent codex`);
  const written = writeJsonIfChanged(hooksPath, config, file.raw);

  return { success: true, hooksPath, backupPath: written.backupPath, addedHooksCount: added };
}

export function removeCodexHooks(projectPath: string): number {
  const path = join(projectPath, ".codex", "hooks.json");
  const file = readJsonObject(path);
  if (file.raw === undefined || !file.data.hooks || typeof file.data.hooks !== "object" || Array.isArray(file.data.hooks)) return 0;
  const n = stripHookGroups(file.data.hooks as Record<string, unknown>);
  if (n > 0) writeJsonIfChanged(path, file.data, file.raw);
  return n;
}

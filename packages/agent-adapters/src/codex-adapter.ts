import { join } from "node:path";
import {
  defaultHookCommand,
  isCtrlplaneCommand,
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
/**
 * Reads `.codex/hooks.json` with `hooks` in the grouped shape. Earlier versions wrote a flat array
 * (`[{ event, command }]`), which Codex does not read: its entries are moved into the grouped shape
 * (ours are dropped, a user's are kept). An array entry that cannot be moved stops the install
 * rather than being lost. Exported so `init` can check the file before it changes anything.
 */
export function readCodexHooksFile(path: string): { data: Record<string, unknown>; raw?: string } {
  const file = readJsonObject(path);
  const config = file.data;
  if (Array.isArray(config.hooks)) {
    const grouped: Record<string, unknown[]> = {};
    for (const entry of config.hooks as unknown[]) {
      const e = (entry ?? {}) as Record<string, unknown>;
      if (isCtrlplaneCommand(e.command)) continue;
      if (typeof e.event !== "string" || typeof e.command !== "string") {
        throw new Error(
          `${path}: a hooks array entry cannot be converted (${JSON.stringify(entry)}); refusing to overwrite it.`,
        );
      }
      const group: Record<string, unknown> = { hooks: [{ type: "command", command: e.command }] };
      if (typeof e.matcher === "string") group.matcher = e.matcher;
      (grouped[e.event] ??= []).push(group);
    }
    config.hooks = grouped;
  }
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  return file;
}

export function injectCodexHooks(
  projectPath: string,
  cliCommand = defaultHookCommand(),
): {
  success: boolean;
  hooksPath: string;
  backupPath?: string;
  addedHooksCount: number;
} {
  const hooksPath = join(projectPath, ".codex", "hooks.json");
  const file = readCodexHooksFile(hooksPath);
  const config = file.data;

  const added = mergeHookGroups(
    config.hooks as Record<string, unknown>,
    CODEX_HOOK_EVENTS,
    (event) => `${cliCommand} ${event} --agent codex`,
  );
  const written = writeJsonIfChanged(hooksPath, config, file.raw);

  return { success: true, hooksPath, backupPath: written.backupPath, addedHooksCount: added };
}

export function removeCodexHooks(projectPath: string): number {
  const path = join(projectPath, ".codex", "hooks.json");
  const file = readJsonObject(path);
  if (
    file.raw === undefined ||
    !file.data.hooks ||
    typeof file.data.hooks !== "object" ||
    Array.isArray(file.data.hooks)
  )
    return 0;
  const n = stripHookGroups(file.data.hooks as Record<string, unknown>);
  if (n > 0) writeJsonIfChanged(path, file.data, file.raw);
  return n;
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeHookEntry {
  matcher?: string;
  command: string;
}

export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeHookEntry[];
    PostToolUse?: ClaudeHookEntry[];
    UserPromptSubmit?: ClaudeHookEntry[];
    Stop?: ClaudeHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function injectClaudeHooks(projectPath: string, cliCommand = "npx ctrlplane hook"): {
  success: boolean;
  settingsPath: string;
  backupPath?: string;
  addedHooksCount: number;
} {
  const claudeDir = join(projectPath, ".claude");
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, "settings.json");
  let settings: ClaudeSettings = {};
  let backupPath: string | undefined;

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf8");
      settings = JSON.parse(raw);

      // Create backup
      backupPath = join(claudeDir, `settings.backup.${Date.now()}.json`);
      writeFileSync(backupPath, raw);
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  let added = 0;
  const hookEvents = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] as const;

  for (const event of hookEvents) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    const eventHooks = settings.hooks[event]!;
    const hookCmd = `${cliCommand} ${event}`;

    const alreadyExists = eventHooks.some((h) => h.command.includes("ctrlplane hook"));
    if (!alreadyExists) {
      eventHooks.push({
        matcher: "*",
        command: hookCmd,
      });
      added++;
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  return {
    success: true,
    settingsPath,
    backupPath,
    addedHooksCount: added,
  };
}


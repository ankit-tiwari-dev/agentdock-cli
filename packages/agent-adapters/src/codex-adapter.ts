import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CodexHookEntry {
  event: string;
  command: string;
}

export function injectCodexHooks(projectPath: string, cliCommand = "npx ctrlplane hook"): {
  success: boolean;
  hooksPath: string;
  backupPath?: string;
  addedHooksCount: number;
} {
  const codexDir = join(projectPath, ".codex");
  if (!existsSync(codexDir)) {
    mkdirSync(codexDir, { recursive: true });
  }

  const hooksPath = join(codexDir, "hooks.json");
  let hooksConfig: { hooks?: CodexHookEntry[] } = { hooks: [] };
  let backupPath: string | undefined;

  if (existsSync(hooksPath)) {
    try {
      const raw = readFileSync(hooksPath, "utf8");
      hooksConfig = JSON.parse(raw);
      backupPath = join(codexDir, `hooks.backup.${Date.now()}.json`);
      writeFileSync(backupPath, raw);
    } catch {
      hooksConfig = { hooks: [] };
    }
  }

  if (!Array.isArray(hooksConfig.hooks)) {
    hooksConfig.hooks = [];
  }

  let added = 0;
  const events = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];

  for (const event of events) {
    const exists = hooksConfig.hooks.some(
      (h) => h.event === event && h.command.includes("ctrlplane hook")
    );
    if (!exists) {
      hooksConfig.hooks.push({
        event,
        command: `${cliCommand} ${event}`,
      });
      added++;
    }
  }

  writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2));

  return {
    success: true,
    hooksPath,
    backupPath,
    addedHooksCount: added,
  };
}


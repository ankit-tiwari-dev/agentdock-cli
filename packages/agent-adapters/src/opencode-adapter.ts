import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function injectOpenCodePlugin(projectPath: string, pluginPackage = "@ctrlplane/opencode-plugin"): {
  success: boolean;
  configPath: string;
  backupPath?: string;
  pluginAdded: boolean;
} {
  const configPath = join(projectPath, "opencode.json");
  let config: { plugins?: string[] } = { plugins: [] };
  let backupPath: string | undefined;

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      config = JSON.parse(raw);
      backupPath = join(projectPath, `opencode.backup.${Date.now()}.json`);
      writeFileSync(backupPath, raw);
    } catch {
      config = { plugins: [] };
    }
  }

  if (!Array.isArray(config.plugins)) {
    config.plugins = [];
  }

  let added = false;
  if (!config.plugins.includes(pluginPackage)) {
    config.plugins.push(pluginPackage);
    added = true;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    success: true,
    configPath,
    backupPath,
    pluginAdded: added,
  };
}


import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SpecManager } from "../../../intent/src/index.ts";
import {
  injectClaudeHooks,
  injectCodexHooks,
  injectOpenCodePlugin,
  readCodexHooksFile,
  readJsonObject,
  readOpenCodeConfig,
} from "../../../agent-adapters/src/index.ts";
import { DEFAULT_PROJECT_CONFIG } from "../../../policy-engine/src/config.ts";

/**
 * Reads every agent config file `init` is about to change, so a file it cannot safely merge into
 * (invalid JSON, wrong shape) stops the install before anything has been created or rewritten.
 */
function checkAgentConfigs(projectPath: string, targetAgent: string): void {
  if (targetAgent === "claude" || targetAgent === "all") {
    readJsonObject(join(projectPath, ".claude", "settings.json"));
    readJsonObject(join(projectPath, ".claude", "settings.local.json"));
  }
  if (targetAgent === "codex" || targetAgent === "all") readCodexHooksFile(join(projectPath, ".codex", "hooks.json"));
  if (targetAgent === "opencode" || targetAgent === "all")
    readOpenCodeConfig(join(projectPath, ".opencode", "opencode.json"));
}

export function handleInit(options?: { projectPath?: string; agent?: string }): {
  success: boolean;
  message: string;
} {
  const projectPath = options?.projectPath ?? process.cwd();
  const ctrlplaneDir = join(projectPath, ".ctrlplane");
  checkAgentConfigs(projectPath, options?.agent?.toLowerCase() ?? "all");

  if (!existsSync(ctrlplaneDir)) {
    mkdirSync(ctrlplaneDir, { recursive: true });
  }

  // Spec and shared policy config are meant to be committed; runtime state is not.
  const gitignorePath = join(ctrlplaneDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      [
        "audit.db",
        "audit.db-*",
        "blobs/",
        "state/",
        "daemon.lock",
        "daemon.log",
        "dashboard.token",
        "*.local.json",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  // 1. Initialize spec.md
  const specManager = new SpecManager(projectPath);
  specManager.init("Project Control Plane Specification", "Define your feature requirements and criteria.");

  // 2. Shared policy config (committed). Personal overrides go in policies.local.json.
  const policyPath = join(ctrlplaneDir, "policies.json");
  if (!existsSync(policyPath)) {
    writeFileSync(policyPath, JSON.stringify(DEFAULT_PROJECT_CONFIG, null, 2) + "\n", "utf8");
  }

  // 3. Inject hooks based on selected agent
  const targetAgent = options?.agent?.toLowerCase() ?? "all";
  const messages: string[] = ["Initialized .ctrlplane configuration and spec.md."];

  if (targetAgent === "claude" || targetAgent === "all") {
    const claudeRes = injectClaudeHooks(projectPath);
    messages.push(`Claude Code: Installed ${claudeRes.addedHooksCount} hook(s) in .claude/settings.local.json.`);
  }

  if (targetAgent === "codex" || targetAgent === "all") {
    const codexRes = injectCodexHooks(projectPath);
    messages.push(
      `Codex CLI: Installed ${codexRes.addedHooksCount} hook(s) in .codex/hooks.json (approve them once in Codex: "Review hooks").`,
    );
  }

  if (targetAgent === "opencode" || targetAgent === "all") {
    const openRes = injectOpenCodePlugin(projectPath);
    messages.push(
      `OpenCode: Plugin at .opencode/plugins/ctrlplane.mjs (${openRes.pluginAdded ? "added" : "already present"}).`,
    );
  }

  return {
    success: true,
    message: messages.join("\n"),
  };
}

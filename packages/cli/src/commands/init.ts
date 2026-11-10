import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SpecManager } from "../../../intent/src/index.ts";
import {
  injectClaudeHooks,
  injectCodexHooks,
  injectOpenCodePlugin,
} from "../../../agent-adapters/src/index.ts";

export function handleInit(options?: { projectPath?: string; agent?: string }): {
  success: boolean;
  message: string;
} {
  const projectPath = options?.projectPath ?? process.cwd();
  const ctrlplaneDir = join(projectPath, ".ctrlplane");

  if (!existsSync(ctrlplaneDir)) {
    mkdirSync(ctrlplaneDir, { recursive: true });
  }

  // 1. Initialize spec.md
  const specManager = new SpecManager(projectPath);
  specManager.init("Project Control Plane Specification", "Define your feature requirements and criteria.");

  // 2. Initialize default policies.yaml if not present
  const policyPath = join(ctrlplaneDir, "policies.yaml");
  if (!existsSync(policyPath)) {
    const defaultPoliciesYaml = `# @ctrlplane Policy Configuration
version: "1.0"
enforce_test_integrity: true

rules:
  - id: "RULE-BLOCK-DESTRUCTIVE-SHELL"
    action: "DENY"
    message: "Destructive commands (rm -rf, git push --force) are blocked."

  - id: "RULE-PROTECT-TESTS"
    action: "REQUIRE_MANUAL_APPROVAL"
    message: "Modifying existing test assertions requires developer approval."
`;
    writeFileSync(policyPath, defaultPoliciesYaml, "utf8");
  }

  // 3. Inject hooks based on selected agent
  const targetAgent = options?.agent?.toLowerCase() ?? "all";
  const messages: string[] = ["Initialized .ctrlplane configuration and spec.md."];

  if (targetAgent === "claude" || targetAgent === "all") {
    const claudeRes = injectClaudeHooks(projectPath);
    messages.push(`Claude Code: Injected ${claudeRes.addedHooksCount} hook(s) into .claude/settings.json.`);
  }

  if (targetAgent === "codex" || targetAgent === "all") {
    const codexRes = injectCodexHooks(projectPath);
    messages.push(`Codex CLI: Injected ${codexRes.addedHooksCount} hook(s) into .codex/hooks.json.`);
  }

  if (targetAgent === "opencode" || targetAgent === "all") {
    const openRes = injectOpenCodePlugin(projectPath);
    messages.push(`OpenCode: Registered plugin in opencode.json (${openRes.pluginAdded ? "added" : "already present"}).`);
  }

  return {
    success: true,
    message: messages.join("\n"),
  };
}


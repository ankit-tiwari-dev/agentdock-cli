import type { PolicyRule } from "../../core/src/index.ts";

export const DEFAULT_SAFETY_RULES: PolicyRule[] = [
  // 1. Control Plane Invariant Protection
  {
    id: "RULE-BLOCK-CTRLPLANE-MUTATION",
    name: "Protect Control Plane Files",
    description: "Blocks AI agents from modifying control plane configuration, specs, or Git internals.",
    event: "PreToolUse",
    targetTools: ["Edit", "Write", "Bash"],
    filePatterns: [".ctrlplane/**", ".git/**"],
    action: "DENY",
    message: "Access Denied: AI agents are strictly forbidden from modifying control plane configuration or Git internals.",
  },

  // 2. Destructive Shell Commands Guard
  {
    id: "RULE-BLOCK-DESTRUCTIVE-SHELL",
    name: "Block Destructive Shell Commands",
    description: "Prevents recursive file deletions, force-pushes, and hard resets.",
    event: "PreToolUse",
    targetTools: ["Bash", "execute_command", "run_command"],
    commandPatterns: [
      "^\\s*rm\\s+-[rf]{1,2}\\s+.*",
      ".*--force.*",
      "^\\s*git\\s+push\\s+.*",
      "^\\s*git\\s+reset\\s+--hard.*",
      "^\\s*git\\s+clean\\s+-fd.*",
      ".*DROP\\s+TABLE.*",
      ".*format\\s+[c-z]:.*",
    ],
    action: "DENY",
    message: "Destructive command blocked by safety policy. Use targeted, non-destructive operations.",
  },

  // 3. Sensitive Credentials Read Guard
  {
    id: "RULE-BLOCK-SECRET-READS",
    name: "Block Sensitive File Reads",
    description: "Prevents agents from printing or exfiltrating private keys and .env secrets.",
    event: "PreToolUse",
    targetTools: ["Read", "read_file", "Bash"],
    filePatterns: [
      "**/.env*",
      "**/*.pem",
      "**/*.key",
      "~/.ssh/**",
      "**/.aws/**",
    ],
    action: "DENY",
    message: "Security Policy: Reading private credentials, environment secrets, or private keys is prohibited.",
  },

  // 4. Anti-Test-Gaming Guard (Existing Test Protection)
  {
    id: "RULE-PROTECT-EXISTING-TESTS",
    name: "Anti-Test-Gaming Guard",
    description: "Requires manual approval or blocks modifying existing test suites.",
    event: "PreToolUse",
    targetTools: ["Edit", "Write", "edit_file", "write_file"],
    filePatterns: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
    ],
    conditions: [
      {
        type: "EXISTING_FILE_MODIFIED",
      },
    ],
    action: "REQUIRE_MANUAL_APPROVAL",
    message: "Anti-Test-Gaming Policy: Modification of existing test suites requires explicit developer approval. Coding agents must fix bugs in source code, not weaken test assertions.",
  },
];


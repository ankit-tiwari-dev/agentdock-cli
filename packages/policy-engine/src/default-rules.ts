import type { PolicyRule } from "../../core/src/index.ts";
import { isSensitiveFile, isTestFile } from "../../git-analyzer/src/index.ts";
import { matchesAnyGlob } from "./glob.ts";
import {
  argv,
  isCatastrophicDelete,
  isDiskWipe,
  isForceClean,
  isForcePush,
  isHardReset,
  readsSensitiveFile,
  writesUnder,
} from "./command-checks.ts";

export const AGENT_HOOK_CONFIG_FILES = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".cursor/hooks.json",
  ".opencode/opencode.json",
  ".opencode/plugins/ctrlplane.mjs",
  ".gemini/settings.json",
];

// Memory is injected into every future session, so only the developer may write it.
const OFF_SWITCH_VERBS = String.raw`(?:stop|pause|uninstall|policies\s+(?:disable|off|observe|set)|memory\s+(?:add|rm))\b`;
const SUPERVISOR_OFF_SWITCH = new RegExp(
  String.raw`\bctrlplane(?:\.cmd|\.ps1)?\s+${OFF_SWITCH_VERBS}|\bbin\.ts["']?\s+${OFF_SWITCH_VERBS}`,
  "i",
);

export const DEFAULT_SAFETY_RULES: PolicyRule[] = [
  {
    id: "RULE-BLOCK-AGENT-SELF-TAMPER",
    name: "Prevent Agent Self-Tampering",
    description: "Blocks agents from editing their own hook configuration or switching the supervisor off.",
    event: "PreToolUse",
    category: "integrity",
    alwaysOn: true,
    targetTools: ["Edit", "Write", "Bash"],
    filePatterns: AGENT_HOOK_CONFIG_FILES,
    action: "DENY",
    message: "Security Violation: Agents cannot edit or disable their own supervision hooks.",
    check: (ctx) => {
      for (const sub of ctx.subCommands) {
        if (SUPERVISOR_OFF_SWITCH.test(sub)) {
          return {
            message: `Security Violation: Agents cannot stop, pause or reconfigure their own supervisor or write its memory (Triggered by command: '${sub}')`,
          };
        }
        if (writesUnder(sub, AGENT_HOOK_CONFIG_FILES)) {
          return {
            message: `Security Violation: Agents cannot edit or disable their own supervision hooks. (Triggered by command: '${sub}')`,
          };
        }
      }
      return null;
    },
  },

  {
    id: "RULE-BLOCK-CTRLPLANE-MUTATION",
    name: "Protect Control Plane Files",
    description: "Blocks agents from modifying supervisor state, specs, or Git internals.",
    event: "PreToolUse",
    category: "integrity",
    alwaysOn: true,
    targetTools: ["Edit", "Write", "Bash"],
    filePatterns: [".ctrlplane/**", ".git/**"],
    action: "DENY",
    message:
      "Access Denied: AI agents are strictly forbidden from modifying control plane configuration or Git internals.",
    check: (ctx) => {
      const home = process.env.CTRLPLANE_HOME?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (home) {
        const hit = ctx.filePaths.find((p) => {
          const lower = p.toLowerCase();
          return lower === home || lower.startsWith(`${home}/`);
        });
        if (hit)
          return {
            message: `Access Denied: AI agents cannot modify the user-level control plane config. (Target file: '${hit}')`,
          };
      }
      for (const sub of ctx.subCommands) {
        if (writesUnder(sub, [".ctrlplane/", ".git/"])) {
          return {
            message: `Access Denied: AI agents are strictly forbidden from modifying control plane configuration or Git internals. (Triggered by command: '${sub}')`,
          };
        }
      }
      return null;
    },
  },

  {
    id: "RULE-BLOCK-DESTRUCTIVE-SHELL",
    name: "Block Destructive Shell Commands",
    description:
      "Blocks recursive deletes of root/home/outside-project paths, force pushes, hard resets, forced cleans and disk wipes.",
    event: "PreToolUse",
    category: "destructive",
    targetTools: ["Bash"],
    action: "DENY",
    message: "Destructive command blocked by safety policy. Use targeted, non-destructive operations.",
    check: (ctx) => {
      for (const sub of ctx.subCommands) {
        let what: string | null = null;
        if (isCatastrophicDelete(sub, ctx.projectRoot))
          what = "recursive delete outside the project or of a protected location";
        else if (isForcePush(sub)) what = "force push (use --force-with-lease if you must rewrite your own branch)";
        else if (isHardReset(sub)) what = "git reset --hard discards uncommitted work";
        else if (isForceClean(sub)) what = "git clean -fd deletes untracked files";
        else if (isDiskWipe(sub)) what = "disk format or raw device write";
        if (what) {
          return {
            message: `Destructive command blocked by safety policy: ${what}. Use targeted, non-destructive operations. (Triggered by command: '${sub}')`,
          };
        }
      }
      return null;
    },
  },

  {
    id: "RULE-BLOCK-SECRET-READS",
    name: "Block Secret File Access",
    description:
      "Blocks reading or writing .env files, private keys and credential stores. Example env files stay readable.",
    event: "PreToolUse",
    category: "secrets",
    targetTools: ["Read", "Edit", "Write", "Grep", "Bash"],
    action: "DENY",
    message: "Security Policy: Reading private credentials, environment secrets, or private keys is prohibited.",
    check: (ctx) => {
      for (const p of ctx.filePaths) {
        if (isSensitiveFile(p)) {
          return {
            message: `Security Policy: Reading private credentials, environment secrets, or private keys is prohibited. (Target file: '${p}')`,
          };
        }
      }
      for (const sub of ctx.subCommands) {
        const file = readsSensitiveFile(sub);
        if (file) {
          return {
            message: `Security Policy: Reading private credentials, environment secrets, or private keys is prohibited. (Triggered by command: '${sub}')`,
          };
        }
      }
      return null;
    },
  },

  {
    id: "RULE-PROTECT-EXISTING-TESTS",
    name: "Anti-Test-Gaming Guard",
    description: "Asks the developer before an agent edits or deletes an existing test file. New test files are fine.",
    event: "PreToolUse",
    category: "integrity",
    targetTools: ["Edit", "Write", "Bash"],
    params: { extraTestGlobs: [] as string[] },
    action: "REQUIRE_MANUAL_APPROVAL",
    message:
      "Anti-Test-Gaming Policy: Modification of existing test suites requires explicit developer approval. Coding agents must fix bugs in source code, not weaken test assertions.",
    check: (ctx, params) => {
      const extra = Array.isArray(params.extraTestGlobs) ? (params.extraTestGlobs as string[]) : [];
      const isTest = (p: string) => isTestFile(p) || (extra.length > 0 && matchesAnyGlob(p, extra));
      for (const p of ctx.filePaths) {
        if (isTest(p) && ctx.isExistingFile(p)) {
          return {
            message: `Anti-Test-Gaming Policy: Modification of existing test suites requires explicit developer approval. Coding agents must fix bugs in source code, not weaken test assertions. (Target file: '${p}')`,
          };
        }
      }
      for (const sub of ctx.subCommands) {
        const t = argv(sub);
        if (
          (t[0] === "rm" || (t[0] === "git" && t[1] === "rm") || t[0] === "mv") &&
          t.slice(1).some((a) => !a.startsWith("-") && isTest(a))
        ) {
          return {
            message: `Anti-Test-Gaming Policy: Deleting or moving existing tests requires explicit developer approval. (Triggered by command: '${sub}')`,
          };
        }
      }
      return null;
    },
  },
];

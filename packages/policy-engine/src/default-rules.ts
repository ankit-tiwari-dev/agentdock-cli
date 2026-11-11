import type { PolicyRule } from "../../core/src/index.ts";
import { isSensitiveFile, isTestFile } from "../../git-analyzer/src/index.ts";
import { matchesAnyGlob } from "./glob.ts";
import {
  argv,
  argvVariants,
  comparablePath,
  ctrlplaneHome,
  cwdPerSubCommand,
  gitSubcommand,
  isCatastrophicDelete,
  isDiskWipe,
  isForceCheckout,
  isForceClean,
  isForcePush,
  isHardReset,
  isInside,
  readsSensitiveFile,
  shellTouchesProtected,
  type ShellPathPolicy,
} from "./command-checks.ts";
import { isDynamicWord, normalizeProgram } from "./shell.ts";

/** Freezes an object graph so code loaded later (a custom rules module) cannot rewrite it. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value as object)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

export const AGENT_HOOK_CONFIG_FILES: readonly string[] = Object.freeze([
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".cursor/hooks.json",
  ".opencode/opencode.json",
  ".opencode/plugins/ctrlplane.mjs",
  ".gemini/settings.json",
]);

/** The folders holding those files: deleting or moving one removes the hooks inside it. */
const AGENT_HOOK_DIRS: readonly string[] = Object.freeze([
  ...new Set(
    AGENT_HOOK_CONFIG_FILES.flatMap((f) =>
      f
        .split("/")
        .slice(0, -1)
        .map((_, i, a) => a.slice(0, i + 1).join("/")),
    ),
  ),
]);

const HOOK_CONFIG_PATHS = [...AGENT_HOOK_CONFIG_FILES, ...AGENT_HOOK_DIRS];

// Raw-text match, kept for an off-switch typed inside another program's string
// (`node -e "execSync('ctrlplane stop')"`). Memory is injected into every future session,
// so only the developer may write it.
const OFF_SWITCH_VERBS = String.raw`(?:stop|pause|uninstall|policies\s+(?:disable|off|observe|set)|memory\s+(?:add|rm))\b`;
const SUPERVISOR_OFF_SWITCH = new RegExp(
  String.raw`\bctrlplane(?:\.cmd|\.ps1)?\s+${OFF_SWITCH_VERBS}|\bbin\.ts["']?\s+${OFF_SWITCH_VERBS}`,
  "i",
);

/**
 * `ctrlplane` sub-commands an agent must never run on itself: they stop, pause, weaken or
 * uninstall supervision (`init` can rewrite the hooks), or write what the next session is told
 * (`handoff`, `memory add`) or treats as approved (`spec approve`). `words` exclude options.
 */
function isOffSwitch(words: string[]): boolean {
  const [a, b] = words.map((w) => w.toLowerCase());
  if (a === undefined) return false;
  if (a === "stop" || a === "pause" || a === "uninstall" || a === "init") return true;
  if (a === "policies") return b === "disable" || b === "off" || b === "observe" || b === "set";
  if (a === "memory") return b === "add" || b === "rm";
  if (a === "handoff") return b !== "show";
  if (a === "spec") return b === "approve";
  return false;
}

const CLI_PACKAGE = /@ctrlplane\/cli(?:@[\w.-]+)?$/i;
const CLI_SCRIPT = /(?:^|[\\/])bin\.[jt]s$/i;

/**
 * Looks at the words as the shell will run them (quotes and escapes removed, wrappers peeled),
 * so `ctrl''plane "pause"`, `ctrlplane pa\use` and `npx ctrlplane --verbose stop` all match. A
 * command name the shell computes at run time (`c=ctrlplane; $c pause`) followed by an
 * off-switch verb is treated as the CLI too.
 */
export function isSupervisorOffSwitch(sub: string): boolean {
  if (SUPERVISOR_OFF_SWITCH.test(sub)) return true;
  for (const words of argvVariants(sub)) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const isCli =
        normalizeProgram(w) === "ctrlplane" ||
        CLI_PACKAGE.test(w) ||
        CLI_SCRIPT.test(w) ||
        (i === 0 && isDynamicWord(w));
      if (!isCli) continue;
      if (isOffSwitch(words.slice(i + 1).filter((x) => !x.startsWith("-")))) return true;
    }
  }
  return false;
}

export interface SafetyRuleOptions {
  /** Further files agents may never write, e.g. the configured custom rules module (absolute paths). */
  protectedFiles?: string[];
}

/**
 * Builds the always-on and default safety rules. Each call returns fresh rule objects, so the
 * engine for a project is never built from objects a custom rules module could have reached.
 */
export function createSafetyRules(options: SafetyRuleOptions = {}): PolicyRule[] {
  const protectedFiles = [...(options.protectedFiles ?? [])];

  const hookConfigPolicy: ShellPathPolicy = {
    isProtected: (p) => matchesAnyGlob(p, HOOK_CONFIG_PATHS),
    samples: HOOK_CONFIG_PATHS,
  };

  const isProtectedFile = (p: string, root: string) =>
    protectedFiles.some((f) => comparablePath(p, root) === comparablePath(f, root));

  return [
    {
      id: "RULE-BLOCK-AGENT-SELF-TAMPER",
      name: "Prevent Agent Self-Tampering",
      description: "Blocks agents from editing their own hook configuration or switching the supervisor off.",
      event: "PreToolUse",
      category: "integrity",
      alwaysOn: true,
      targetTools: ["Edit", "Write", "Bash"],
      filePatterns: [...AGENT_HOOK_CONFIG_FILES],
      action: "DENY",
      message: "Security Violation: Agents cannot edit or disable their own supervision hooks.",
      check: (ctx) => {
        for (const sub of ctx.subCommands) {
          if (isSupervisorOffSwitch(sub)) {
            return {
              message: `Security Violation: Agents cannot stop, pause, re-install or reconfigure their own supervisor, or write its memory, handoffs or spec approval (Triggered by command: '${sub}')`,
            };
          }
        }
        const sub = shellTouchesProtected(ctx.subCommands, ctx.projectRoot, hookConfigPolicy);
        if (sub) {
          return {
            message: `Security Violation: Agents cannot edit or disable their own supervision hooks. (Triggered by command: '${sub}')`,
          };
        }
        return null;
      },
    },

    {
      id: "RULE-BLOCK-CTRLPLANE-MUTATION",
      name: "Protect Control Plane Files",
      description:
        "Blocks agents from modifying supervisor state, specs, user-level config, custom rules or Git internals.",
      event: "PreToolUse",
      category: "integrity",
      alwaysOn: true,
      targetTools: ["Edit", "Write", "Bash"],
      filePatterns: [".ctrlplane/**", ".git/**"],
      action: "DENY",
      message:
        "Access Denied: AI agents are strictly forbidden from modifying control plane configuration or Git internals.",
      check: (ctx) => {
        const home = ctrlplaneHome();
        const root = ctx.projectRoot;
        const hit = ctx.filePaths.find((p) => isInside(p, home, root) || isProtectedFile(p, root));
        if (hit)
          return {
            message: `Access Denied: AI agents cannot modify the user-level control plane config or custom rules. (Target file: '${hit}')`,
          };
        const policy: ShellPathPolicy = {
          isProtected: (p) =>
            matchesAnyGlob(p, [".ctrlplane", ".ctrlplane/**", ".git", ".git/**"]) ||
            isInside(p, home, root) ||
            isProtectedFile(p, root),
          samples: [".ctrlplane", ".git", ...protectedFiles],
        };
        const sub = shellTouchesProtected(ctx.subCommands, root, policy);
        if (sub) {
          return {
            message: `Access Denied: AI agents are strictly forbidden from modifying control plane configuration or Git internals. (Triggered by command: '${sub}')`,
          };
        }
        return null;
      },
    },

    {
      id: "RULE-BLOCK-DESTRUCTIVE-SHELL",
      name: "Block Destructive Shell Commands",
      description:
        "Blocks recursive deletes of root/home/outside-project paths, force pushes, hard resets, forced checkouts, forced cleans and disk wipes.",
      event: "PreToolUse",
      category: "destructive",
      targetTools: ["Bash"],
      action: "DENY",
      message: "Destructive command blocked by safety policy. Use targeted, non-destructive operations.",
      check: (ctx) => {
        const cwds = cwdPerSubCommand(ctx.subCommands);
        for (let i = 0; i < ctx.subCommands.length; i++) {
          const sub = ctx.subCommands[i];
          let what: string | null = null;
          if (isCatastrophicDelete(sub, ctx.projectRoot, cwds[i]))
            what = "recursive delete outside the project or of a protected location";
          else if (isForcePush(sub)) what = "force push (use --force-with-lease if you must rewrite your own branch)";
          else if (isHardReset(sub)) what = "git reset --hard discards uncommitted work";
          else if (isForceCheckout(sub)) what = "a forced checkout discards uncommitted work";
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
      description:
        "Asks the developer before an agent edits or deletes an existing test file. New test files are fine.",
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
          const g = gitSubcommand(sub);
          const operands =
            g && (g.verb === "rm" || g.verb === "mv") ? g.args : t[0] === "rm" || t[0] === "mv" ? t.slice(1) : null;
          if (operands && operands.some((a) => !a.startsWith("-") && isTest(a))) {
            return {
              message: `Anti-Test-Gaming Policy: Deleting or moving existing tests requires explicit developer approval. (Triggered by command: '${sub}')`,
            };
          }
        }
        return null;
      },
    },
  ];
}

export const DEFAULT_SAFETY_RULES: readonly PolicyRule[] = deepFreeze(createSafetyRules());

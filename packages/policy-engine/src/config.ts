import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PolicyAction, PolicyMode, PolicyRule } from "../../core/src/index.ts";
import type { RuleOverride } from "./evaluator.ts";

export interface PolicyConfigFile {
  version?: number;
  rules?: Record<string, RuleOverride>;
  /** Module exporting `rules: PolicyRule[]`, relative to the project root. */
  customRulesFile?: string;
  loopBreaker?: {
    maxConsecutiveFailures?: number;
    identicalCallsToInstruct?: number;
    identicalCallsToAsk?: number;
    maxToolCallsPerPrompt?: number;
  };
  context?: {
    /** Use the local `claude` CLI to write session summaries. Off unless set. */
    aiSummaries?: boolean;
    maxChars?: number;
  };
  budget?: {
    /** Steer the agent once a session's estimated spend passes this many US dollars. */
    sessionUsd?: number;
  };
}

export interface ResolvedPolicyConfig {
  overrides: Record<string, RuleOverride>;
  customRulesFile?: string;
  loopBreaker: NonNullable<PolicyConfigFile["loopBreaker"]>;
  context: Required<NonNullable<PolicyConfigFile["context"]>>;
  budget: NonNullable<PolicyConfigFile["budget"]>;
  sources: string[];
}

export type ConfigScope = "project" | "local" | "user";

export function configPath(projectRoot: string, scope: ConfigScope): string {
  if (scope === "user") return join(process.env.CTRLPLANE_HOME ?? join(homedir(), ".ctrlplane"), "policies.json");
  return join(projectRoot, ".ctrlplane", scope === "local" ? "policies.local.json" : "policies.json");
}

function readConfigFile(path: string): PolicyConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as PolicyConfigFile) : null;
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

const VALID_MODES: PolicyMode[] = ["enforce", "observe"];
const VALID_ACTIONS: PolicyAction[] = ["ALLOW", "DENY", "INSTRUCT", "REQUIRE_MANUAL_APPROVAL"];

/** Later scopes win: user < project < local (your own machine has the last word). */
export function loadPolicyConfig(projectRoot: string): ResolvedPolicyConfig {
  const order: ConfigScope[] = ["user", "project", "local"];
  const resolved: ResolvedPolicyConfig = {
    overrides: {},
    loopBreaker: {},
    context: { aiSummaries: false, maxChars: 6000 },
    budget: {},
    sources: [],
  };

  for (const scope of order) {
    const path = configPath(projectRoot, scope);
    const file = readConfigFile(path);
    if (!file) continue;
    resolved.sources.push(path);

    for (const [id, o] of Object.entries(file.rules ?? {})) {
      if (!o || typeof o !== "object") continue;
      if (o.mode !== undefined && !VALID_MODES.includes(o.mode)) throw new Error(`${path}: rule ${id} has unknown mode '${o.mode}'`);
      if (o.action !== undefined && !VALID_ACTIONS.includes(o.action)) throw new Error(`${path}: rule ${id} has unknown action '${o.action}'`);
      const prev = resolved.overrides[id] ?? {};
      resolved.overrides[id] = { ...prev, ...o, params: { ...(prev.params ?? {}), ...(o.params ?? {}) } };
    }
    if (file.customRulesFile && scope !== "user") resolved.customRulesFile = resolve(projectRoot, file.customRulesFile);
    if (file.customRulesFile && scope === "user") resolved.customRulesFile = resolve(dirname(path), file.customRulesFile);
    Object.assign(resolved.loopBreaker, file.loopBreaker ?? {});
    Object.assign(resolved.context, file.context ?? {});
    Object.assign(resolved.budget, file.budget ?? {});
  }
  return resolved;
}

/** Newest modification time across config files, so long-running processes can reload on change. */
export function configStamp(projectRoot: string): string {
  return (["user", "project", "local"] as ConfigScope[])
    .map((s) => {
      try {
        return String(statSync(configPath(projectRoot, s)).mtimeMs);
      } catch {
        return "-";
      }
    })
    .join("|");
}

export async function loadCustomRules(file: string | undefined): Promise<PolicyRule[]> {
  if (!file || !existsSync(file)) return [];
  const mod = await import(pathToFileURL(isAbsolute(file) ? file : resolve(file)).href);
  const rules = (mod.rules ?? mod.default) as unknown;
  if (!Array.isArray(rules)) throw new Error(`${file} must export \`rules\` (an array of rules).`);
  for (const r of rules as PolicyRule[]) {
    if (!r || typeof r.id !== "string" || typeof r.event !== "string" || typeof r.action !== "string") {
      throw new Error(`${file}: every rule needs id, event and action.`);
    }
  }
  return rules as PolicyRule[];
}

export function updateRuleOverride(projectRoot: string, scope: ConfigScope, ruleId: string, patch: RuleOverride): string {
  const path = configPath(projectRoot, scope);
  const file = readConfigFile(path) ?? { version: 1, rules: {} };
  file.rules = file.rules ?? {};
  file.rules[ruleId] = { ...(file.rules[ruleId] ?? {}), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  return path;
}

export const DEFAULT_PROJECT_CONFIG: PolicyConfigFile = {
  version: 1,
  rules: {
    "RULE-GIT-PROTECTED-BRANCH-PUSH": { params: { protectedBranches: ["main", "master"] } },
  },
  loopBreaker: { identicalCallsToInstruct: 3, identicalCallsToAsk: 5, maxToolCallsPerPrompt: 200 },
  context: { aiSummaries: false },
};

// ---------------------------------------------------------------------------
// Pause: a time-boxed "supervision off" switch for the developer (never the agent).

export const PAUSE_DEFAULT_MS = 30 * 60 * 1000;
export const PAUSE_CEILING_MS = 8 * 60 * 60 * 1000;

export interface PauseState {
  firstPausedAt: number;
  until: number;
}

function pausePath(projectRoot: string): string {
  return join(projectRoot, ".ctrlplane", "state", "pause.json");
}

/** Active pause, or null. Expiry is checked when read; an expired file is removed. */
export function readPause(projectRoot: string, now = Date.now()): PauseState | null {
  const path = pausePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as PauseState;
    if (typeof state.until !== "number" || state.until <= now) {
      rmSync(path, { force: true });
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * Pauses (or extends a pause). The end can never pass 8 hours after the FIRST pause in a run,
 * so repeated renewals cannot switch supervision off indefinitely.
 */
export function setPause(projectRoot: string, durationMs = PAUSE_DEFAULT_MS, now = Date.now()): PauseState {
  const existing = readPause(projectRoot, now);
  const firstPausedAt = existing?.firstPausedAt ?? now;
  const until = Math.min(now + Math.max(0, durationMs), firstPausedAt + PAUSE_CEILING_MS);
  const state = { firstPausedAt, until };
  mkdirSync(dirname(pausePath(projectRoot)), { recursive: true });
  writeFileSync(pausePath(projectRoot), JSON.stringify(state, null, 2));
  return state;
}

export function clearPause(projectRoot: string): boolean {
  const path = pausePath(projectRoot);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** "30m", "2h", "90s", "1h30m" → milliseconds. */
export function parseDuration(text: string | undefined): number | null {
  if (!text) return null;
  const re = /(\d+)\s*(h|m|s)/gi;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total += m[2].toLowerCase() === "h" ? n * 3600_000 : m[2].toLowerCase() === "m" ? n * 60_000 : n * 1000;
  }
  return matched ? total : null;
}

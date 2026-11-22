import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PolicyAction, PolicyMode, PolicyRule } from "../../core/src/index.ts";
import type { RuleOverride } from "./evaluator.ts";
import {
  activePause,
  ctrlplaneHome,
  pauseStatePath,
  projectPolicyPath,
  PAUSE_CEILING_MS,
  type PauseState,
} from "../../core/src/index.ts";
import { BUILTIN_RULES } from "./catalog.ts";

export interface PolicyConfigFile {
  version?: number;
  rules?: Record<string, RuleOverride>;
  /** Module exporting `rules: PolicyRule[]`, relative to `CTRLPLANE_HOME`; honoured only in the user config. */
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
  if (scope === "user") return join(ctrlplaneHome(), "policies.json");
  return projectPolicyPath(projectRoot, scope);
}

/** null for the user scope when `CTRLPLANE_HOME` is relative, so it counts as absent rather than read from the project. */
function readablePath(projectRoot: string, scope: ConfigScope): string | null {
  try {
    return configPath(projectRoot, scope);
  } catch {
    return null;
  }
}

function readConfigFile(path: string): PolicyConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as PolicyConfigFile) : null;
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`, { cause: err });
  }
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  process.stderr.write(`[ctrlplane policy] ${message}\n`);
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Real path of the user config's custom rules module, or undefined when it resolves outside `CTRLPLANE_HOME`. */
function userCustomRulesFile(configFile: string, name: string): string | undefined {
  const target = resolve(dirname(configFile), name);
  let inside: boolean;
  let file = target;
  try {
    file = realpathSync(target);
    inside = isInside(realpathSync(ctrlplaneHome()), file);
  } catch {
    // A module that does not exist yet loads nothing, but its path stays protected from agent writes.
    inside = isInside(resolve(ctrlplaneHome()), target);
  }
  if (inside) return file;
  warnOnce(`${configFile}: customRulesFile ${name} resolves outside ${ctrlplaneHome()} and is ignored.`);
  return undefined;
}

const VALID_MODES: PolicyMode[] = ["enforce", "observe"];
const VALID_ACTIONS: PolicyAction[] = ["ALLOW", "DENY", "INSTRUCT", "REQUIRE_MANUAL_APPROVAL"];

const STRICTNESS: Record<PolicyAction, number> = { ALLOW: 0, INSTRUCT: 1, REQUIRE_MANUAL_APPROVAL: 2, DENY: 3 };
const softeningWarned = new Set<string>();

/**
 * The project file is committed with the repo, so anyone who can push to it could switch a rule
 * off for every clone: from that scope only tightening fields survive, softening ones are dropped.
 */
function tightenOnly(id: string, o: RuleOverride, path: string): RuleOverride {
  // A rule outside the catalog has no known default, so only the strictest action counts as tightening.
  const defaultAction = BUILTIN_RULES.find((r) => r.id === id)?.action ?? "DENY";
  const kept: RuleOverride = { ...o };
  const dropped: string[] = [];
  if (o.enabled === false) {
    delete kept.enabled;
    dropped.push("enabled: false");
  }
  if (o.mode === "observe") {
    delete kept.mode;
    dropped.push('mode: "observe"');
  }
  if (o.action !== undefined && STRICTNESS[o.action] < STRICTNESS[defaultAction]) {
    delete kept.action;
    dropped.push(`action: "${o.action}"`);
  }
  if (!dropped.length) return o;
  const message =
    `${path}: ignored ${dropped.join(", ")} for ${id}; the committed project file can only tighten rules. ` +
    `Put it in .ctrlplane/policies.local.json or your user config (${join(ctrlplaneHome(), "policies.json")}).`;
  if (!softeningWarned.has(message)) {
    softeningWarned.add(message);
    process.stderr.write(`[ctrlplane policy] ${message}\n`);
  }
  return kept;
}

/** Later scopes win: user < project < local (your own machine has the last word); project may only tighten. */
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
    const path = readablePath(projectRoot, scope);
    const file = path === null ? null : readConfigFile(path);
    if (!file || path === null) continue;
    resolved.sources.push(path);

    for (const [id, o] of Object.entries(file.rules ?? {})) {
      if (!o || typeof o !== "object") continue;
      if (o.mode !== undefined && !VALID_MODES.includes(o.mode))
        throw new Error(`${path}: rule ${id} has unknown mode '${o.mode}'`);
      if (o.action !== undefined && !VALID_ACTIONS.includes(o.action))
        throw new Error(`${path}: rule ${id} has unknown action '${o.action}'`);
      const kept = scope === "project" ? tightenOnly(id, o, path) : o;
      const prev = resolved.overrides[id] ?? {};
      resolved.overrides[id] = { ...prev, ...kept, params: { ...(prev.params ?? {}), ...(kept.params ?? {}) } };
    }
    if (file.customRulesFile && scope !== "user")
      warnOnce(
        `${path}: customRulesFile ignored; custom rules belong in the user config ${configPath(projectRoot, "user")}.`,
      );
    if (file.customRulesFile && scope === "user")
      resolved.customRulesFile = userCustomRulesFile(path, file.customRulesFile);
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
        return String(statSync(readablePath(projectRoot, s) ?? "").mtimeMs);
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

export function updateRuleOverride(
  projectRoot: string,
  scope: ConfigScope,
  ruleId: string,
  patch: RuleOverride,
): string {
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
export { PAUSE_CEILING_MS, type PauseState } from "../../core/src/index.ts";

function pausePath(projectRoot: string): string {
  return pauseStatePath(projectRoot);
}

/** Active pause, or null (see `activePause`); an expired or unreadable pause file is removed. */
export function readPause(projectRoot: string, now = Date.now()): PauseState | null {
  const state = activePause(projectRoot, now);
  if (!state) rmSync(pausePath(projectRoot), { force: true });
  return state;
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

const UNIT_MS: Record<string, number> = { h: 3600_000, m: 60_000, s: 1000 };
const isDigit = (c: string) => c >= "0" && c <= "9";

/**
 * "30m", "2h", "90s", "1h30m" → milliseconds: every run of digits followed (after optional whitespace)
 * by h, m or s, in any case. A scan rather than `/(\d+)\s*(h|m|s)/gi`, which retries from every digit
 * of a long digit run and is quadratic on it.
 */
export function parseDuration(text: string | undefined): number | null {
  if (!text) return null;
  let total = 0;
  let matched = false;
  let i = 0;
  while (i < text.length) {
    if (!isDigit(text[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && isDigit(text[i])) i++;
    let next = i;
    while (next < text.length && /\s/.test(text[next])) next++;
    const unit = next < text.length ? UNIT_MS[text[next].toLowerCase()] : undefined;
    if (unit !== undefined) {
      matched = true;
      total += Number(text.slice(start, i)) * unit;
      next++;
    }
    i = next;
  }
  return matched ? total : null;
}

import type { PolicyRule } from "../../core/src/index.ts";
import { BUILTIN_RULES } from "./catalog.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { configStamp, loadCustomRules, loadPolicyConfig, readPause, type ResolvedPolicyConfig } from "./config.ts";
import { PolicyEngine } from "./evaluator.ts";

export interface ProjectEngine {
  engine: PolicyEngine;
  config: ResolvedPolicyConfig;
  customRules: PolicyRule[];
  stamp: string;
  newBreaker: () => CircuitBreaker;
  isPaused: () => boolean;
}

/**
 * Builds the rule engine a project is configured for: built-in catalog first (so a custom rule
 * can never pre-empt an integrity rule), then the project's custom rules, with config overrides.
 */
export async function buildProjectEngine(projectRoot: string): Promise<ProjectEngine> {
  const stamp = configStamp(projectRoot);
  const config = loadPolicyConfig(projectRoot);
  const customRules = await loadCustomRules(config.customRulesFile);
  const builtinIds = new Set(BUILTIN_RULES.map((r) => r.id));
  const clash = customRules.find((r) => builtinIds.has(r.id));
  if (clash) throw new Error(`Custom rule id '${clash.id}' collides with a built-in rule; pick another id.`);

  const newBreaker = () => new CircuitBreaker(config.loopBreaker);
  const engine = new PolicyEngine([...BUILTIN_RULES, ...customRules], {
    overrides: config.overrides,
    breaker: newBreaker(),
  });
  return { engine, config, customRules, stamp, newBreaker, isPaused: () => readPause(projectRoot) !== null };
}

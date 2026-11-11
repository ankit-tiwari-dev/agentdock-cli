import type { PolicyRule } from "../../core/src/index.ts";
import { createBuiltinRules } from "./catalog.ts";
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
 * The built-ins are created after the custom module has run, from code the module cannot reach,
 * and the module's own file is added to the protected files.
 */
export async function buildProjectEngine(projectRoot: string): Promise<ProjectEngine> {
  const stamp = configStamp(projectRoot);
  const config = loadPolicyConfig(projectRoot);
  const customRules = await loadCustomRules(config.customRulesFile);
  const builtins = createBuiltinRules({ protectedFiles: config.customRulesFile ? [config.customRulesFile] : [] });
  const builtinIds = new Set(builtins.map((r) => r.id));
  const clash = customRules.find((r) => builtinIds.has(r.id));
  if (clash) throw new Error(`Custom rule id '${clash.id}' collides with a built-in rule; pick another id.`);

  const newBreaker = () => new CircuitBreaker(config.loopBreaker);
  const engine = new PolicyEngine([...builtins, ...customRules], {
    overrides: config.overrides,
    breaker: newBreaker(),
  });
  return { engine, config, customRules, stamp, newBreaker, isPaused: () => readPause(projectRoot) !== null };
}

/**
 * Built-in rules only, for when the project config or custom rules cannot be loaded. The custom
 * rules file named in the config (when the config itself is readable) stays protected.
 */
export function fallbackProjectEngine(projectRoot: string): PolicyEngine {
  let protectedFiles: string[] = [];
  try {
    const file = loadPolicyConfig(projectRoot).customRulesFile;
    if (file) protectedFiles = [file];
  } catch {
    // Unreadable config: no custom rules file to protect.
  }
  return new PolicyEngine(createBuiltinRules({ protectedFiles }));
}

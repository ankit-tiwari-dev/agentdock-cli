import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  canonicalizeToolInput,
  sameToolKind,
  type PolicyAction,
  type PolicyEvaluationResult,
  type PolicyEvent,
  type PolicyMode,
  type PolicyRule,
  type RuleContext,
  type RuleHit,
} from "../../core/src/index.ts";
import { DEFAULT_SAFETY_RULES } from "./default-rules.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { matchesAnyGlob, toProjectPath } from "./glob.ts";
import { splitShellCommands } from "./shell.ts";

export interface RuleOverride {
  enabled?: boolean;
  mode?: PolicyMode;
  action?: PolicyAction;
  params?: Record<string, unknown>;
}

export interface PolicyEngineOptions {
  overrides?: Record<string, RuleOverride>;
  breaker?: CircuitBreaker;
}

export interface EvaluationContext {
  event: PolicyEvent | string;
  toolName?: string;
  toolInput?: Record<string, unknown> | string;
  filePath?: string;
  command?: string;
  /** Overrides the on-disk existence check (tests, replay of past sessions). */
  isExistingFile?: boolean;
  projectRoot?: string;
  prompt?: string;
  toolResponse?: Record<string, unknown> | string;
  stopHookActive?: boolean;
  permissionMode?: string;
  /** Pause active: only always-on rules run. */
  paused?: boolean;
  /** Per-session loop breaker; defaults to the engine's own. */
  breaker?: CircuitBreaker;
}

interface Verdict {
  decision: PolicyAction;
  rule: PolicyRule;
  reason: string;
}

const SEVERITY: Record<PolicyAction, number> = {
  ALLOW: 0,
  INSTRUCT: 1,
  REQUIRE_MANUAL_APPROVAL: 2,
  DENY: 3,
};

export class PolicyEngine {
  private rules: PolicyRule[];
  private overrides: Record<string, RuleOverride>;
  private circuitBreaker: CircuitBreaker;
  private compiledPatterns = new Map<string, RegExp[]>();

  constructor(customRules?: PolicyRule[], options?: PolicyEngineOptions) {
    this.rules = customRules ?? [...DEFAULT_SAFETY_RULES];
    this.overrides = options?.overrides ?? {};
    this.circuitBreaker = options?.breaker ?? new CircuitBreaker();
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  public getRules(): PolicyRule[] {
    return [...this.rules];
  }

  public setOverrides(overrides: Record<string, RuleOverride>): void {
    this.overrides = overrides;
  }

  /** Effective on/off, mode and params for a rule after config overrides. */
  public resolveRule(rule: PolicyRule): { enabled: boolean; mode: PolicyMode; params: Record<string, unknown> } {
    const o = this.overrides[rule.id] ?? {};
    if (rule.alwaysOn) return { enabled: true, mode: "enforce", params: { ...(rule.params ?? {}), ...(o.params ?? {}) } };
    const enabled = o.enabled ?? rule.enabledByDefault ?? true;
    return { enabled, mode: o.mode ?? rule.mode ?? "enforce", params: { ...(rule.params ?? {}), ...(o.params ?? {}) } };
  }

  public evaluate(context: EvaluationContext): PolicyEvaluationResult {
    const startTime = performance.now();
    const breaker = context.breaker ?? this.circuitBreaker;
    const ctx = this.buildRuleContext(context);

    if (ctx.event === "PreToolUse" && !context.paused) {
      breaker.recordToolCall(this.fingerprint(context));
    }

    const observed: NonNullable<PolicyEvaluationResult["observed"]> = [];
    const instructions: Verdict[] = [];

    for (const rule of this.rules) {
      if (rule.event !== ctx.event) continue;
      const { enabled, mode, params } = this.resolveRule(rule);
      if (!enabled) continue;
      if (context.paused && !rule.alwaysOn) continue;
      if (!this.matchesTool(rule, ctx)) continue;

      const hit = this.matchRule(rule, ctx, params);
      if (!hit) continue;

      const decision = hit.action ?? this.overrides[rule.id]?.action ?? rule.action;
      if (decision === "ALLOW") continue;

      if (mode === "observe") {
        observed.push({ ruleId: rule.id, wouldDecide: decision, reason: hit.message });
        continue;
      }
      if (decision === "INSTRUCT") {
        instructions.push({ decision, rule, reason: hit.message });
        continue;
      }
      return {
        decision,
        matchedRuleId: rule.id,
        reason: hit.message,
        steeringInstruction: rule.message,
        observed: observed.length ? observed : undefined,
        latencyMs: performance.now() - startTime,
      };
    }

    const trip = ctx.event === "PreToolUse" && !context.paused ? breaker.consumeTrip() : null;
    if (trip && SEVERITY[trip.action] > SEVERITY.INSTRUCT) {
      return {
        decision: trip.action,
        matchedRuleId: "LOOP-BREAKER",
        reason: trip.reason,
        steeringInstruction: "Execution halted by loop breaker. Requesting human guidance.",
        observed: observed.length ? observed : undefined,
        latencyMs: performance.now() - startTime,
      };
    }

    const messages = instructions.map((i) => i.reason);
    if (trip) messages.push(trip.reason);
    if (messages.length > 0) {
      return {
        decision: "INSTRUCT",
        matchedRuleId: instructions[0]?.rule.id ?? "LOOP-BREAKER",
        reason: messages.join("\n"),
        steeringInstruction: messages.join("\n"),
        observed: observed.length ? observed : undefined,
        latencyMs: performance.now() - startTime,
      };
    }

    return {
      decision: "ALLOW",
      reason: "Action passed all safety policies.",
      observed: observed.length ? observed : undefined,
      latencyMs: performance.now() - startTime,
    };
  }

  private buildRuleContext(context: EvaluationContext): RuleContext {
    const projectRoot = context.projectRoot ?? process.cwd();
    const canonical = canonicalizeToolInput(context.toolName ?? "", context.toolInput);
    const command = context.command ?? canonical.command;
    const rawPaths = context.filePath ? [context.filePath] : canonical.filePaths;
    const filePaths = rawPaths.map((p) => toProjectPath(p, projectRoot));

    const isExistingFile = (relPath: string): boolean => {
      if (context.isExistingFile !== undefined) return context.isExistingFile;
      try {
        return existsSync(isAbsolute(relPath) ? relPath : resolve(projectRoot, relPath));
      } catch {
        return true;
      }
    };

    return {
      event: context.event as PolicyEvent,
      toolName: context.toolName,
      canonicalVerb: canonical.canonicalVerb,
      command,
      subCommands: command ? splitShellCommands(command) : [],
      filePaths,
      content: canonical.content,
      projectRoot,
      prompt: context.prompt,
      toolResponse: context.toolResponse,
      stopHookActive: context.stopHookActive,
      permissionMode: context.permissionMode,
      isExistingFile,
    };
  }

  private matchesTool(rule: PolicyRule, ctx: RuleContext): boolean {
    if (!rule.targetTools || rule.targetTools.length === 0 || rule.targetTools.includes("*")) return true;
    if (!ctx.toolName) return false;
    return rule.targetTools.some((t) => sameToolKind(t, ctx.toolName!));
  }

  private patternsFor(rule: PolicyRule): RegExp[] {
    let compiled = this.compiledPatterns.get(rule.id);
    if (!compiled) {
      compiled = (rule.commandPatterns ?? []).map((p) => new RegExp(p, "i"));
      this.compiledPatterns.set(rule.id, compiled);
    }
    return compiled;
  }

  private matchRule(rule: PolicyRule, ctx: RuleContext, params: Record<string, unknown>): RuleHit | null {
    if (rule.commandPatterns && ctx.subCommands.length > 0) {
      const patterns = this.patternsFor(rule);
      for (const sub of ctx.subCommands) {
        if (patterns.some((re) => re.test(sub))) {
          return { message: `${rule.message} (Triggered by command: '${sub}')` };
        }
      }
    }

    if (rule.filePatterns && ctx.filePaths.length > 0) {
      const needsExisting = rule.conditions?.some((c) => c.type === "EXISTING_FILE_MODIFIED");
      for (const p of ctx.filePaths) {
        if (!matchesAnyGlob(p, rule.filePatterns)) continue;
        if (needsExisting && !ctx.isExistingFile(p)) continue;
        return { message: `${rule.message} (Target file: '${p}')` };
      }
    }

    if (rule.check) {
      try {
        return rule.check(ctx, params);
      } catch {
        // A broken rule must not take the agent down with it.
        return null;
      }
    }
    return null;
  }

  private fingerprint(context: EvaluationContext): string | undefined {
    if (!context.toolName) return undefined;
    try {
      return `${context.toolName}:${JSON.stringify(context.toolInput ?? null)}`;
    } catch {
      return undefined;
    }
  }
}

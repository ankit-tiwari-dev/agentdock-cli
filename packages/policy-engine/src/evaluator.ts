import { performance } from "node:perf_hooks";
import type { PolicyRule, PolicyEvaluationResult } from "../../core/src/index.ts";
import { isTestFile, isSensitiveFile, isCtrlplaneFile } from "../../git-analyzer/src/index.ts";
import { DEFAULT_SAFETY_RULES } from "./default-rules.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";

export interface EvaluationContext {
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
  toolName?: string;
  toolInput?: Record<string, unknown> | string;
  filePath?: string;
  command?: string;
  isExistingFile?: boolean;
}

export class PolicyEngine {
  private rules: PolicyRule[];
  private circuitBreaker: CircuitBreaker;

  constructor(customRules?: PolicyRule[]) {
    this.rules = customRules ?? [...DEFAULT_SAFETY_RULES];
    this.circuitBreaker = new CircuitBreaker();
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Synchronously evaluates a tool invocation against active policies
   * Guaranteed execution time < 5ms
   */
  public evaluate(context: EvaluationContext): PolicyEvaluationResult {
    const startTime = performance.now();

    // 1. Check Circuit Breaker first
    this.circuitBreaker.recordToolCall();
    const cbState = this.circuitBreaker.getState();
    if (cbState.isTriggered) {
      return {
        decision: "REQUIRE_MANUAL_APPROVAL",
        reason: cbState.triggerReason || "Circuit breaker triggered.",
        steeringInstruction: "Execution halted by loop breaker. Requesting human guidance.",
        latencyMs: performance.now() - startTime,
      };
    }

    // Extract command and file path from input if not passed explicitly
    const command = context.command ?? this.extractCommand(context.toolInput);
    const filePath = context.filePath ?? this.extractFilePath(context.toolInput);

    // 2. Evaluate against configured rules
    for (const rule of this.rules) {
      if (rule.event !== context.event) continue;

      // Check tool target
      if (rule.targetTools && context.toolName) {
        const matchesTool =
          rule.targetTools.includes("*") ||
          rule.targetTools.some((t) => t.toLowerCase() === context.toolName?.toLowerCase());
        if (!matchesTool) continue;
      }

      // Check Command Patterns
      if (rule.commandPatterns && command) {
        const subCommands = this.splitChainedCommands(command);
        for (const sub of subCommands) {
          for (const pattern of rule.commandPatterns) {
            const regex = new RegExp(pattern, "i");
            if (regex.test(sub)) {
              return {
                decision: rule.action,
                matchedRuleId: rule.id,
                reason: `${rule.message} (Triggered by command: '${sub}')`,
                steeringInstruction: rule.message,
                latencyMs: performance.now() - startTime,
              };
            }
          }
        }
      }

      // Check File Patterns
      if (filePath) {
        if (rule.filePatterns && this.matchesFilePattern(filePath, rule.filePatterns)) {
          // Special condition: EXISTING_FILE_MODIFIED
          const hasExistingFileCondition = rule.conditions?.some(
            (c) => c.type === "EXISTING_FILE_MODIFIED"
          );

          if (hasExistingFileCondition) {
            // If it's explicitly a new file, rule does not match
            if (context.isExistingFile === false) {
              continue;
            }
          }

          return {
            decision: rule.action,
            matchedRuleId: rule.id,
            reason: `${rule.message} (Target file: '${filePath}')`,
            steeringInstruction: rule.message,
            latencyMs: performance.now() - startTime,
          };
        }
      }
    }

    // Default Allow
    return {
      decision: "ALLOW",
      reason: "Action passed all safety policies.",
      latencyMs: performance.now() - startTime,
    };
  }

  private extractCommand(input?: Record<string, unknown> | string): string | undefined {
    if (!input) return undefined;
    if (typeof input === "string") return input;
    if (typeof input.command === "string") return input.command;
    if (typeof input.cmd === "string") return input.cmd;
    return undefined;
  }

  private extractFilePath(input?: Record<string, unknown> | string): string | undefined {
    if (!input || typeof input !== "object") return undefined;
    if (typeof input.filePath === "string") return input.filePath;
    if (typeof input.path === "string") return input.path;
    if (typeof input.file === "string") return input.file;
    return undefined;
  }

  private splitChainedCommands(cmd: string): string[] {
    return cmd
      .split(/&&|\|\||;/g)
      .map((c) => c.trim())
      .filter(Boolean);
  }

  private matchesFilePattern(filePath: string, patterns: string[]): boolean {
    const normalized = filePath.replace(/\\/g, "/");

    // Fast path: special category helpers
    if (patterns.includes(".ctrlplane/**") && isCtrlplaneFile(normalized)) return true;
    if (patterns.includes("**/.env*") && isSensitiveFile(normalized)) return true;
    if (patterns.includes("**/*.test.*") && isTestFile(normalized)) return true;

    // Glob regex matching
    for (const pat of patterns) {
      const regexPattern = pat
        .replace(/\\/g, "/")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, ".");
      const regex = new RegExp(`^${regexPattern}$`, "i");
      if (regex.test(normalized)) return true;
    }

    return false;
  }
}


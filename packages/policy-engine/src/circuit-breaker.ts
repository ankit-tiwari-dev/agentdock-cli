import type { PolicyAction } from "../../core/src/index.ts";

export interface CircuitBreakerConfig {
  /** Same failure signature this many times in a row → ask the human. */
  maxConsecutiveFailures: number;
  /** Identical tool call (same tool, same input) this many times in a row → steer the agent. */
  identicalCallsToInstruct: number;
  /** Identical tool call this many times in a row → ask the human. */
  identicalCallsToAsk: number;
  /** Tool calls since the last human prompt → ask the human for a checkpoint. */
  maxToolCallsPerPrompt: number;
}

export interface CircuitBreakerState {
  consecutiveFailures: number;
  lastFailureSignature?: string;
  identicalCallStreak: number;
  lastCallFingerprint?: string;
  toolCallsSincePrompt: number;
  /** Kept for callers that only read the old field name. */
  consecutiveToolCalls: number;
  isTriggered: boolean;
  triggerReason?: string;
  triggerAction?: PolicyAction;
}

export interface BreakerTrip {
  action: PolicyAction;
  reason: string;
}

/**
 * Loop breaker. Counters reset when the human sends a new prompt, and a trip is consumed
 * once reported, so one loop produces one interruption instead of blocking forever.
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;

  constructor(config?: Partial<CircuitBreakerConfig> & { maxConsecutiveToolCalls?: number }) {
    this.config = {
      maxConsecutiveFailures: config?.maxConsecutiveFailures ?? 3,
      identicalCallsToInstruct: config?.identicalCallsToInstruct ?? 3,
      identicalCallsToAsk: config?.identicalCallsToAsk ?? 5,
      maxToolCallsPerPrompt: config?.maxToolCallsPerPrompt ?? config?.maxConsecutiveToolCalls ?? 200,
    };
    this.state = CircuitBreaker.freshState();
  }

  private static freshState(): CircuitBreakerState {
    return {
      consecutiveFailures: 0,
      identicalCallStreak: 0,
      toolCallsSincePrompt: 0,
      consecutiveToolCalls: 0,
      isTriggered: false,
    };
  }

  private trip(action: PolicyAction, reason: string): void {
    const severity = (a?: PolicyAction) => (a === "REQUIRE_MANUAL_APPROVAL" ? 2 : a === "INSTRUCT" ? 1 : 0);
    if (this.state.isTriggered && severity(this.state.triggerAction) >= severity(action)) return;
    this.state.isTriggered = true;
    this.state.triggerAction = action;
    this.state.triggerReason = reason;
  }

  public recordToolCall(fingerprint?: string): void {
    this.state.toolCallsSincePrompt++;
    this.state.consecutiveToolCalls = this.state.toolCallsSincePrompt;

    if (fingerprint !== undefined && fingerprint === this.state.lastCallFingerprint) {
      this.state.identicalCallStreak++;
    } else {
      this.state.identicalCallStreak = 1;
      this.state.lastCallFingerprint = fingerprint;
    }

    if (fingerprint !== undefined && this.state.identicalCallStreak >= this.config.identicalCallsToAsk) {
      this.trip(
        "REQUIRE_MANUAL_APPROVAL",
        `Loop Detected: the identical tool call was repeated ${this.state.identicalCallStreak} times in a row. Asking the developer before continuing.`,
      );
      this.state.identicalCallStreak = 0;
      this.state.lastCallFingerprint = undefined;
    } else if (fingerprint !== undefined && this.state.identicalCallStreak === this.config.identicalCallsToInstruct) {
      this.trip(
        "INSTRUCT",
        `STOP repeating: you have made this exact tool call ${this.state.identicalCallStreak} times in a row and it is not making progress. Re-read the last output, form a new hypothesis, and try a different approach.`,
      );
    }

    if (this.state.toolCallsSincePrompt >= this.config.maxToolCallsPerPrompt) {
      this.trip(
        "REQUIRE_MANUAL_APPROVAL",
        `Checkpoint: ${this.state.toolCallsSincePrompt} tool calls since the developer's last prompt (limit ${this.config.maxToolCallsPerPrompt}). Developer checkpoint required.`,
      );
      this.state.toolCallsSincePrompt = 0;
      this.state.consecutiveToolCalls = 0;
    }
  }

  public recordExecutionResult(success: boolean, signature?: string): void {
    if (success) {
      this.state.consecutiveFailures = 0;
      this.state.lastFailureSignature = undefined;
      return;
    }

    if (this.state.consecutiveFailures > 0 && this.state.lastFailureSignature === signature) {
      this.state.consecutiveFailures++;
    } else {
      this.state.consecutiveFailures = 1;
      this.state.lastFailureSignature = signature;
    }

    if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.trip(
        "REQUIRE_MANUAL_APPROVAL",
        `Loop Detected: Same failure repeated ${this.state.consecutiveFailures} consecutive times (${signature || "unknown error"}). Halting agent to prevent token waste.`,
      );
      this.state.consecutiveFailures = 0;
    }
  }

  /** Returns the pending trip, if any, and clears it. */
  public consumeTrip(): BreakerTrip | null {
    if (!this.state.isTriggered) return null;
    const trip = {
      action: this.state.triggerAction ?? "REQUIRE_MANUAL_APPROVAL",
      reason: this.state.triggerReason ?? "Loop breaker triggered.",
    };
    this.state.isTriggered = false;
    this.state.triggerAction = undefined;
    this.state.triggerReason = undefined;
    return trip;
  }

  /** A new human prompt is a checkpoint: the agent is no longer running unsupervised. */
  public resetForNewPrompt(): void {
    this.state = CircuitBreaker.freshState();
  }

  public reset(): void {
    this.state = CircuitBreaker.freshState();
  }

  public getState(): CircuitBreakerState {
    return { ...this.state };
  }
}

export interface CircuitBreakerConfig {
  maxConsecutiveFailures: number;
  maxConsecutiveToolCalls: number;
}

export interface CircuitBreakerState {
  consecutiveFailures: number;
  lastFailureSignature?: string;
  consecutiveToolCalls: number;
  isTriggered: boolean;
  triggerReason?: string;
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      maxConsecutiveFailures: config?.maxConsecutiveFailures ?? 3,
      maxConsecutiveToolCalls: config?.maxConsecutiveToolCalls ?? 40,
    };
    this.state = {
      consecutiveFailures: 0,
      consecutiveToolCalls: 0,
      isTriggered: false,
    };
  }

  public recordToolCall(): void {
    this.state.consecutiveToolCalls++;
    if (this.state.consecutiveToolCalls >= this.config.maxConsecutiveToolCalls) {
      this.state.isTriggered = true;
      this.state.triggerReason = `Exceeded maximum consecutive unsupervised tool calls (${this.config.maxConsecutiveToolCalls}). Developer checkpoint required.`;
    }
  }

  public recordExecutionResult(success: boolean, signature?: string): void {
    if (!success) {
      if (this.state.lastFailureSignature === signature) {
        this.state.consecutiveFailures++;
      } else {
        this.state.consecutiveFailures = 1;
        this.state.lastFailureSignature = signature;
      }

      if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        this.state.isTriggered = true;
        this.state.triggerReason = `Loop Detected: Same failure repeated ${this.state.consecutiveFailures} consecutive times (${signature || "unknown error"}). Halting agent to prevent token waste.`;
      }
    } else {
      this.state.consecutiveFailures = 0;
      this.state.lastFailureSignature = undefined;
    }
  }

  public reset(): void {
    this.state = {
      consecutiveFailures: 0,
      consecutiveToolCalls: 0,
      isTriggered: false,
    };
  }

  public getState(): CircuitBreakerState {
    return { ...this.state };
  }
}


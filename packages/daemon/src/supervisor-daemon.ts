import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import {
  detectToolFailure,
  type AgentHookPayload,
  type AgentType,
  type DaemonStatus,
  type EventType,
  type HookEventName,
  type HookVerdictResponse,
  type PolicyAction,
} from "../../core/src/index.ts";
import { StorageEngine } from "../../storage/src/index.ts";
import {
  buildProjectEngine,
  configStamp,
  CircuitBreaker,
  fallbackProjectEngine,
  PolicyEngine,
  type ProjectEngine,
  type RuleOverride,
} from "../../policy-engine/src/index.ts";
import { ContextRecorder, type RecorderOptions } from "../../context/src/recorder.ts";
import { IPCServer, type IPCEndpoint } from "./ipc-server.ts";
import { findProjectRoot } from "./lock.ts";

export {
  DAEMON_UNAVAILABLE,
  findProjectRoot,
  getRunningDaemonLock,
  isDaemonLock,
  isProcessAlive,
  type DaemonLock,
} from "./lock.ts";

export const DAEMON_VERSION = "0.2.0";

export interface DaemonConfig {
  projectPath: string;
  dbPath?: string;
  ipcPathOrPort?: string | number;
  /** Rule overrides from policies config (enabled / mode / params). */
  overrides?: Record<string, RuleOverride>;
  /** Called after every handled hook, e.g. to stream to the dashboard. */
  onEvent?: (event: DaemonEventNotice) => void;
  /** Decides per call whether non-always-on rules are paused. */
  isPaused?: (sessionId: string) => boolean;
  /** Project rules and config; reloaded when a config file changes. */
  projectEngine?: ProjectEngine;
  /** Context recording options (tests inject a fake summary runner here). */
  recorder?: RecorderOptions;
}

export interface DaemonEventNotice {
  sessionId: string;
  sequenceNum: number;
  eventType: EventType;
  toolName?: string;
  decision: PolicyAction;
  reason: string;
  matchedRuleId?: string;
  observedOnly: boolean;
  createdAt: number;
}

const EVENT_TYPE: Record<HookEventName, EventType> = {
  PreToolUse: "pre_tool",
  PostToolUse: "post_tool",
  UserPromptSubmit: "user_prompt",
  Stop: "stop",
  SubagentStop: "subagent_stop",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  PreCompact: "pre_compact",
  Notification: "notification",
};

const DEFAULT_SESSION = "sess_default";

export class SupervisorDaemon {
  private config: DaemonConfig;
  private projectRoot: string;
  private storage: StorageEngine;
  private policyEngine: PolicyEngine;
  private ipcServer: IPCServer;
  private startTime: number;
  private activeSessionId: string | null = null;
  private sequenceBySession = new Map<string, number>();
  private breakers = new Map<string, CircuitBreaker>();
  private knownSessions = new Set<string>();
  private lockFilePath: string;
  private dbPath: string;
  private shutdownRequested: (() => void) | null = null;
  private projectEngine: ProjectEngine | null;
  private reloading = false;
  private recorderOptions: RecorderOptions;
  private recorder: ContextRecorder;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.projectRoot = resolve(config.projectPath);
    this.startTime = Date.now();

    this.dbPath = config.dbPath ?? join(this.projectRoot, ".ctrlplane", "audit.db");
    this.storage = new StorageEngine(this.dbPath);
    this.projectEngine = config.projectEngine ?? null;
    this.policyEngine =
      this.projectEngine?.engine ??
      (config.overrides
        ? new PolicyEngine(undefined, { overrides: config.overrides })
        : fallbackProjectEngine(this.projectRoot));
    this.recorderOptions = { aiSummaries: this.projectEngine?.config.context.aiSummaries ?? false, ...config.recorder };
    this.recorder = new ContextRecorder(this.storage, this.projectRoot, this.recorderOptions);

    this.lockFilePath = join(this.projectRoot, ".ctrlplane", "daemon.lock");

    this.ipcServer = new IPCServer((payload) => this.handleHookPayload(payload), config.ipcPathOrPort);
  }

  /** Picks up edited policies.json files without a restart; the old rules serve until the new ones load. */
  private reloadIfConfigChanged(): void {
    const current = this.projectEngine;
    if (!current || this.reloading) return;
    if (configStamp(this.projectRoot) === current.stamp) return;
    this.reloading = true;
    buildProjectEngine(this.projectRoot)
      .then((next) => {
        this.projectEngine = next;
        this.policyEngine = next.engine;
        this.recorderOptions.aiSummaries = next.config.context.aiSummaries;
      })
      .catch((err) => {
        console.error(`[ctrlplane daemon] config reload failed, keeping previous rules: ${String(err)}`);
        current.stamp = configStamp(this.projectRoot);
      })
      .finally(() => {
        this.reloading = false;
      });
  }

  public getRecorder(): ContextRecorder {
    return this.recorder;
  }

  public getStorage(): StorageEngine {
    return this.storage;
  }

  public getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  public getBreaker(sessionId: string): CircuitBreaker {
    let breaker = this.breakers.get(sessionId);
    if (!breaker) {
      breaker = this.projectEngine?.newBreaker() ?? new CircuitBreaker();
      this.breakers.set(sessionId, breaker);
    }
    return breaker;
  }

  /** Resolves when a shutdown control frame arrives over IPC. */
  public waitForShutdownRequest(): Promise<void> {
    return new Promise((res) => {
      this.shutdownRequested = res;
    });
  }

  public async start(): Promise<IPCEndpoint> {
    const endpoint = await this.ipcServer.start();

    const ctrlplaneDir = dirname(this.lockFilePath);
    if (!existsSync(ctrlplaneDir)) {
      mkdirSync(ctrlplaneDir, { recursive: true });
    }

    const ipcTarget = endpoint.path || `${endpoint.host}:${endpoint.port}`;
    const lockData = {
      pid: process.pid,
      ipcTarget,
      startedAt: this.startTime,
      version: DAEMON_VERSION,
    };
    writeFileSync(this.lockFilePath, JSON.stringify(lockData, null, 2));

    return endpoint;
  }

  public async stop(): Promise<void> {
    await this.ipcServer.stop();
    this.storage.close();

    if (existsSync(this.lockFilePath)) {
      try {
        const lock = JSON.parse(readFileSync(this.lockFilePath, "utf8"));
        if (lock.pid === process.pid) unlinkSync(this.lockFilePath);
      } catch {
        // A lock we cannot read is not ours to remove.
      }
    }
  }

  public getStatus(): DaemonStatus {
    const endpoint = this.ipcServer.getEndpoint();
    const ipcTarget = endpoint.path || `${endpoint.host}:${endpoint.port}`;
    let databaseSizeBytes = 0;
    try {
      if (this.dbPath !== ":memory:") databaseSizeBytes = statSync(this.dbPath).size;
    } catch {
      databaseSizeBytes = 0;
    }
    return {
      pid: process.pid,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      ipcPath: ipcTarget,
      activeSessionId: this.activeSessionId,
      databaseSizeBytes,
      connectedAgentsCount: this.knownSessions.size,
      version: DAEMON_VERSION,
    };
  }

  private ensureSession(sessionId: string, payload: AgentHookPayload): void {
    if (this.knownSessions.has(sessionId)) return;
    this.knownSessions.add(sessionId);
    let created = false;
    try {
      created = this.storage.ensureSession({
        id: sessionId,
        agentType: (payload.agent ?? "custom") as AgentType,
        projectPath: this.projectRoot,
        gitBranch: "unknown",
        baseCommitSha: "0000000000000000000000000000000000000000",
        status: "active",
        startedAt: Date.now(),
        metadata: payload.transcriptPath ? { transcriptPath: payload.transcriptPath } : undefined,
      });
      this.sequenceBySession.set(sessionId, this.storage.lastSequenceNum(sessionId));
    } catch {
      // Storage problems must never block the agent loop.
    }
    // Git lookups take tens of milliseconds; they run after the verdict is sent.
    if (created) {
      readGitHead(this.projectRoot).then((git) => {
        try {
          this.storage.updateSessionGit(sessionId, git.branch, git.sha);
        } catch {
          // Store may already be closed.
        }
      });
    }
  }

  private nextSequence(sessionId: string): number {
    const n = (this.sequenceBySession.get(sessionId) ?? 0) + 1;
    this.sequenceBySession.set(sessionId, n);
    return n;
  }

  public handleHookPayload(payload: AgentHookPayload): HookVerdictResponse {
    const startTime = performance.now();

    if (payload.control === "shutdown") {
      setImmediate(() => this.shutdownRequested?.());
      return { decision: "ALLOW", exitCode: 0, stdoutMessage: "shutting down", latencyMs: 0 };
    }
    if (payload.control === "ping") {
      return { decision: "ALLOW", exitCode: 0, stdoutMessage: DAEMON_VERSION, latencyMs: 0 };
    }

    this.reloadIfConfigChanged();
    const sessionId = payload.sessionId ?? DEFAULT_SESSION;
    this.activeSessionId = sessionId;
    this.ensureSession(sessionId, payload);
    const breaker = this.getBreaker(sessionId);

    if (payload.hookEventName === "UserPromptSubmit") {
      breaker.resetForNewPrompt();
    } else if (payload.hookEventName === "PostToolUse") {
      const outcome = detectToolFailure(payload.toolName, payload.toolResponse);
      breaker.recordExecutionResult(!outcome.failed, outcome.signature);
    } else if (payload.hookEventName === "SessionEnd") {
      try {
        this.storage.updateSessionStatus(sessionId, "completed");
      } catch {
        // Status is informational.
      }
    }

    const policyResult = this.policyEngine.evaluate({
      event: payload.hookEventName,
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      toolResponse: payload.toolResponse,
      prompt: payload.prompt,
      projectRoot: (payload.cwd && findProjectRoot(payload.cwd)) || this.projectRoot,
      stopHookActive: payload.stopHookActive,
      permissionMode: payload.permissionMode,
      paused: this.config.isPaused?.(sessionId) ?? this.projectEngine?.isPaused() ?? false,
      breaker,
    });

    const exitCode: 0 | 2 = policyResult.decision === "DENY" ? 2 : 0;
    const observedOnly = policyResult.decision === "ALLOW" && !!policyResult.observed?.length;
    const reason = observedOnly
      ? `Observe mode: would ${policyResult.observed![0].wouldDecide} — ${policyResult.observed![0].reason}`
      : policyResult.reason;

    const eventType = EVENT_TYPE[payload.hookEventName] ?? "notification";
    const sequenceNum = this.nextSequence(sessionId);
    const createdAt = Date.now();
    try {
      this.storage.insertEvent({
        id: `evt_${sessionId}_${sequenceNum}_${createdAt}`,
        sessionId,
        sequenceNum,
        eventType,
        toolName: payload.toolName,
        toolInput: payload.toolInput ?? (payload.prompt !== undefined ? { prompt: payload.prompt } : undefined),
        toolOutput: payload.toolResponse,
        policyVerdict: policyResult.decision,
        policyReason: reason,
        executionDurationMs: Math.round(performance.now() - startTime),
        createdAt,
      });
    } catch {
      // Storage problems must never block the agent loop.
    }

    try {
      this.recorder.record(payload, sessionId);
    } catch (err) {
      console.error(`[ctrlplane daemon] context recording failed: ${String(err)}`);
    }

    try {
      this.config.onEvent?.({
        sessionId,
        sequenceNum,
        eventType,
        toolName: payload.toolName,
        decision: policyResult.decision,
        reason,
        matchedRuleId: policyResult.matchedRuleId ?? policyResult.observed?.[0]?.ruleId,
        observedOnly,
        createdAt,
      });
    } catch {
      // Listeners are best effort.
    }

    return {
      decision: policyResult.decision,
      exitCode,
      stderrMessage: policyResult.decision === "ALLOW" ? undefined : policyResult.reason,
      steeringInstruction: policyResult.steeringInstruction,
      matchedRuleId: policyResult.matchedRuleId,
      observedOnly,
      latencyMs: performance.now() - startTime,
    };
  }
}

const execFileAsync = promisify(execFile);

async function readGitHead(cwd: string): Promise<{ branch: string; sha: string }> {
  const run = async (args: string[]) =>
    (await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 2000 })).stdout.trim();
  try {
    return { branch: await run(["rev-parse", "--abbrev-ref", "HEAD"]), sha: await run(["rev-parse", "HEAD"]) };
  } catch {
    return { branch: "unknown", sha: "0000000000000000000000000000000000000000" };
  }
}

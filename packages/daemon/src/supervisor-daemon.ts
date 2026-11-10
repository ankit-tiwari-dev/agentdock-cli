import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  AgentHookPayload,
  HookVerdictResponse,
  DaemonStatus,
} from "../../core/src/index.ts";
import { StorageEngine } from "../../storage/src/index.ts";
import { PolicyEngine } from "../../policy-engine/src/index.ts";
import { IPCServer, type IPCEndpoint } from "./ipc-server.ts";

export interface DaemonConfig {
  projectPath: string;
  dbPath?: string;
  ipcPathOrPort?: string | number;
}

export class SupervisorDaemon {
  private config: DaemonConfig;
  private storage: StorageEngine;
  private policyEngine: PolicyEngine;
  private ipcServer: IPCServer;
  private startTime: number;
  private activeSessionId: string | null = null;
  private sequenceCounter: number = 0;
  private lockFilePath: string;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.startTime = Date.now();

    const dbPath = config.dbPath ?? join(config.projectPath, ".ctrlplane", "audit.db");
    this.storage = new StorageEngine(dbPath);
    this.policyEngine = new PolicyEngine();

    this.lockFilePath = join(config.projectPath, ".ctrlplane", "daemon.lock");

    this.ipcServer = new IPCServer(
      (payload) => this.handleHookPayload(payload),
      config.ipcPathOrPort
    );
  }

  public getStorage(): StorageEngine {
    return this.storage;
  }

  public getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  public async start(): Promise<IPCEndpoint> {
    const endpoint = await this.ipcServer.start();

    // Ensure .ctrlplane dir exists
    const ctrlplaneDir = dirname(this.lockFilePath);
    if (!existsSync(ctrlplaneDir)) {
      mkdirSync(ctrlplaneDir, { recursive: true });
    }

    const ipcTarget = endpoint.path || `${endpoint.host}:${endpoint.port}`;

    // Write lock file
    const lockData = {
      pid: process.pid,
      ipcTarget,
      startedAt: this.startTime,
    };
    writeFileSync(this.lockFilePath, JSON.stringify(lockData, null, 2));

    return endpoint;
  }

  public async stop(): Promise<void> {
    await this.ipcServer.stop();
    this.storage.close();

    if (existsSync(this.lockFilePath)) {
      try {
        unlinkSync(this.lockFilePath);
      } catch {
        // Ignore lock removal failure on exit
      }
    }
  }

  public getStatus(): DaemonStatus {
    const endpoint = this.ipcServer.getEndpoint();
    const ipcTarget = endpoint.path || `${endpoint.host}:${endpoint.port}`;
    return {
      pid: process.pid,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      ipcPath: ipcTarget,
      activeSessionId: this.activeSessionId,
      databaseSizeBytes: 0,
      connectedAgentsCount: 1,
      version: "0.1.0",
    };
  }

  private handleHookPayload(payload: AgentHookPayload): HookVerdictResponse {
    const startTime = performance.now();

    if (payload.sessionId) {
      this.activeSessionId = payload.sessionId;
    }

    // 1. Evaluate policy
    const policyResult = this.policyEngine.evaluate({
      event: payload.hookEventName === "PreToolUse" ? "PreToolUse" : "PostToolUse",
      toolName: payload.toolName,
      toolInput: payload.toolInput,
    });

    const isDenied = policyResult.decision === "DENY" || policyResult.decision === "REQUIRE_MANUAL_APPROVAL";
    const exitCode: 0 | 2 = isDenied ? 2 : 0;

    // 2. Asynchronously ingest event into storage
    this.sequenceCounter++;
    try {
      this.storage.insertEvent({
        id: `evt_${this.sequenceCounter}_${Date.now()}`,
        sessionId: this.activeSessionId ?? "sess_default",
        sequenceNum: this.sequenceCounter,
        eventType: payload.hookEventName === "PreToolUse" ? "pre_tool" : "post_tool",
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        toolOutput: payload.toolResponse,
        policyVerdict: policyResult.decision,
        policyReason: policyResult.reason,
        executionDurationMs: Math.round(performance.now() - startTime),
        createdAt: Date.now(),
      });
    } catch {
      // Storage error must not block agent loop
    }

    const elapsed = performance.now() - startTime;

    return {
      decision: policyResult.decision,
      exitCode,
      stderrMessage: isDenied ? policyResult.reason : undefined,
      steeringInstruction: policyResult.steeringInstruction,
      latencyMs: elapsed,
    };
  }
}

/**
 * Reads existing daemon lock file to find running daemon
 */
export function getRunningDaemonLock(projectPath: string): { pid: number; ipcTarget: string } | null {
  const lockPath = join(projectPath, ".ctrlplane", "daemon.lock");
  if (!existsSync(lockPath)) return null;

  try {
    const content = readFileSync(lockPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

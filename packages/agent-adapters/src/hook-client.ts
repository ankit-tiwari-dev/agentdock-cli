import { createConnection } from "node:net";
import type { AgentHookPayload, HookVerdictResponse } from "../../core/src/index.ts";
import { findProjectRoot, getRunningDaemonLock } from "../../daemon/src/lock.ts";

export interface HookClientOptions {
  projectPath?: string;
  timeoutMs?: number;
  ciMode?: boolean;
}

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

/** Marks a verdict produced because no daemon answered (as opposed to a real policy decision). */
export const DAEMON_UNAVAILABLE = "daemon-unavailable";

/**
 * Dispatches an agent hook payload to the local running supervisor daemon
 */
export async function dispatchHook(
  payload: AgentHookPayload,
  options?: HookClientOptions,
): Promise<HookVerdictResponse> {
  const projectPath = options?.projectPath ?? findProjectRoot(payload.cwd || process.cwd()) ?? process.cwd();
  const timeoutMs = options?.timeoutMs ?? 1500;
  const isCi = options?.ciMode ?? (process.env.CTRLPLANE_MODE === "ci" || process.env.CI === "true");

  const lock = getRunningDaemonLock(projectPath);
  if (!lock) {
    if (isCi) {
      return {
        decision: "DENY",
        exitCode: 2,
        stderrMessage: "[ctrlplane error] Supervisor daemon is not running. CI mode requires fail-close.",
        latencyMs: 0,
      };
    }
    return {
      decision: "ALLOW",
      exitCode: 0,
      stderrMessage: "[ctrlplane warning] Supervisor daemon is not running, failing open.",
      matchedRuleId: DAEMON_UNAVAILABLE,
      latencyMs: 0,
    };
  }

  return new Promise((resolve) => {
    let hasResolved = false;
    const timer = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        client.destroy();
        if (isCi) {
          resolve({
            decision: "DENY",
            exitCode: 2,
            stderrMessage: "[ctrlplane timeout] Supervisor daemon did not respond within timeout. CI mode fails close.",
            matchedRuleId: DAEMON_UNAVAILABLE,
            latencyMs: timeoutMs,
          });
        } else {
          resolve({
            decision: "ALLOW",
            exitCode: 0,
            stderrMessage: "[ctrlplane timeout] Supervisor daemon timeout, failing open.",
            matchedRuleId: DAEMON_UNAVAILABLE,
            latencyMs: timeoutMs,
          });
        }
      }
    }, timeoutMs);

    const client = createConnection(connectOptions(lock.ipcTarget), () => {
      client.write(JSON.stringify(payload) + "\n");
    });

    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) {
        clearTimeout(timer);
        if (!hasResolved) {
          hasResolved = true;
          client.end();
          try {
            const res: HookVerdictResponse = JSON.parse(buffer.trim());
            resolve(res);
          } catch {
            resolve({
              decision: "ALLOW",
              exitCode: 0,
              latencyMs: 0,
            });
          }
        }
      }
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      if (!hasResolved) {
        hasResolved = true;
        if (isCi) {
          resolve({
            decision: "DENY",
            exitCode: 2,
            stderrMessage: `[ctrlplane IPC error] ${err.message}. CI mode fails close.`,
            matchedRuleId: DAEMON_UNAVAILABLE,
            latencyMs: 0,
          });
        } else {
          resolve({
            decision: "ALLOW",
            exitCode: 0,
            stderrMessage: `[ctrlplane IPC warning] ${err.message}, failing open.`,
            matchedRuleId: DAEMON_UNAVAILABLE,
            latencyMs: 0,
          });
        }
      }
    });
  });
}

function connectOptions(ipcTarget: string): { path: string } | { host: string; port: number } {
  if (ipcTarget.startsWith(WINDOWS_PIPE_PREFIX) || ipcTarget.startsWith("/")) return { path: ipcTarget };
  const [host, port] = ipcTarget.split(":");
  return { host, port: parseInt(port, 10) };
}

/** Sends a control frame (ping / shutdown) to the daemon. Resolves null if it does not answer. */
export function sendDaemonControl(
  ipcTarget: string,
  control: "ping" | "shutdown",
  timeoutMs = 1500,
): Promise<HookVerdictResponse | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: HookVerdictResponse | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const client = createConnection(connectOptions(ipcTarget), () => {
      client.write(JSON.stringify({ hookEventName: "Notification", cwd: "", control }) + "\n");
    });
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        finish(JSON.parse(buffer.trim()));
      } catch {
        finish(null);
      }
    });
    client.on("error", () => finish(null));
  });
}

import { createConnection } from "node:net";
import type { AgentHookPayload, HookVerdictResponse } from "../../core/src/index.ts";
import { getRunningDaemonLock } from "../../daemon/src/index.ts";

export interface HookClientOptions {
  projectPath?: string;
  timeoutMs?: number;
  ciMode?: boolean;
}

/**
 * Dispatches an agent hook payload to the local running supervisor daemon
 */
export async function dispatchHook(
  payload: AgentHookPayload,
  options?: HookClientOptions
): Promise<HookVerdictResponse> {
  const projectPath = options?.projectPath ?? process.cwd();
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
            latencyMs: timeoutMs,
          });
        } else {
          resolve({
            decision: "ALLOW",
            exitCode: 0,
            stderrMessage: "[ctrlplane timeout] Supervisor daemon timeout, failing open.",
            latencyMs: timeoutMs,
          });
        }
      }
    }, timeoutMs);

    // Parse ipcTarget: named pipe / unix socket path OR host:port
    const isNamedPipeOrSocket = lock.ipcTarget.startsWith("\\\\.\\pipe\\") || lock.ipcTarget.startsWith("/");
    const opts = isNamedPipeOrSocket
      ? { path: lock.ipcTarget }
      : {
          host: lock.ipcTarget.split(":")[0],
          port: parseInt(lock.ipcTarget.split(":")[1], 10),
        };

    const client = createConnection(opts as any, () => {
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
            latencyMs: 0,
          });
        } else {
          resolve({
            decision: "ALLOW",
            exitCode: 0,
            stderrMessage: `[ctrlplane IPC warning] ${err.message}, failing open.`,
            latencyMs: 0,
          });
        }
      }
    });
  });
}


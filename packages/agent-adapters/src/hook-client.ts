import { createConnection, type Socket } from "node:net";
import type { AgentHookPayload, HookVerdictResponse } from "../../core/src/index.ts";
import { DAEMON_UNAVAILABLE, findProjectRoot, getRunningDaemonLock } from "../../daemon/src/lock.ts";

export { DAEMON_UNAVAILABLE };

export interface HookClientOptions {
  projectPath?: string;
  timeoutMs?: number;
  ciMode?: boolean;
}

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const DECISIONS = new Set(["ALLOW", "DENY", "INSTRUCT", "REQUIRE_MANUAL_APPROVAL"]);

/** CI fails closed when supervision cannot be confirmed. */
export function isCiMode(): boolean {
  return process.env.CTRLPLANE_MODE === "ci" || process.env.CI === "true";
}

/**
 * Verdict for "no daemon gave a usable answer". Locally it carries the marker, so the hook runs
 * the rules in its own process; in CI it denies.
 */
function unavailable(isCi: boolean, reason: string, latencyMs = 0): HookVerdictResponse {
  if (isCi) {
    return {
      decision: "DENY",
      exitCode: 2,
      stderrMessage: `[ctrlplane error] ${reason}. CI mode fails close.`,
      matchedRuleId: DAEMON_UNAVAILABLE,
      latencyMs,
    };
  }
  return {
    decision: "ALLOW",
    exitCode: 0,
    stderrMessage: `[ctrlplane warning] ${reason}, failing open.`,
    matchedRuleId: DAEMON_UNAVAILABLE,
    latencyMs,
  };
}

function isVerdict(value: unknown): value is HookVerdictResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.decision === "string" && DECISIONS.has(v.decision) && (v.exitCode === 0 || v.exitCode === 2);
}

/**
 * Dispatches an agent hook payload to the local running supervisor daemon
 */
export async function dispatchHook(
  payload: AgentHookPayload,
  options?: HookClientOptions,
): Promise<HookVerdictResponse> {
  const projectPath = options?.projectPath ?? findProjectRoot(payload.cwd || process.cwd()) ?? process.cwd();
  const timeoutMs = options?.timeoutMs ?? 1500;
  const isCi = options?.ciMode ?? isCiMode();

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

  const target = connectOptions(lock.ipcTarget);
  if (!target) return unavailable(isCi, `Daemon lock has an unusable IPC target '${lock.ipcTarget}'`);

  return new Promise((resolve) => {
    let hasResolved = false;
    let client: Socket | null = null;
    const finish = (verdict: HookVerdictResponse) => {
      if (hasResolved) return;
      hasResolved = true;
      clearTimeout(timer);
      client?.destroy();
      resolve(verdict);
    };
    const timer = setTimeout(
      () => finish(unavailable(isCi, "Supervisor daemon did not respond within timeout", timeoutMs)),
      timeoutMs,
    );

    try {
      client = createConnection(target, () => {
        client?.write(JSON.stringify(payload) + "\n");
      });
    } catch (err) {
      // An invalid address throws synchronously; inside a Promise executor that would reject the hook.
      finish(unavailable(isCi, `Cannot reach the daemon: ${(err as Error).message}`));
      return;
    }

    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      let reply: unknown;
      try {
        reply = JSON.parse(buffer.slice(0, buffer.indexOf("\n")).trim());
      } catch {
        reply = undefined;
      }
      finish(isVerdict(reply) ? reply : unavailable(isCi, "Supervisor daemon sent an unreadable reply"));
    });

    client.on("error", (err) => finish(unavailable(isCi, `IPC error: ${err.message}`)));
  });
}

/** Socket options for a lock's IPC target, or null when it is not a pipe/socket path or `host:port`. */
function connectOptions(ipcTarget: string): { path: string } | { host: string; port: number } | null {
  if (ipcTarget.startsWith(WINDOWS_PIPE_PREFIX) || ipcTarget.startsWith("/")) return { path: ipcTarget };
  const m = /^([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(ipcTarget);
  if (!m) return null;
  const port = Number(m[2]);
  if (port <= 0 || port > 65535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ""), port };
}

/** Sends a control frame (ping / shutdown) to the daemon. Resolves null if it does not answer. */
export function sendDaemonControl(
  ipcTarget: string,
  control: "ping" | "shutdown",
  timeoutMs = 1500,
): Promise<HookVerdictResponse | null> {
  const target = connectOptions(ipcTarget);
  if (!target) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let client: Socket | null = null;
    const finish = (value: HookVerdictResponse | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      client = createConnection(target, () => {
        client?.write(JSON.stringify({ hookEventName: "Notification", cwd: "", control }) + "\n");
      });
    } catch {
      finish(null);
      return;
    }
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        const reply: unknown = JSON.parse(buffer.slice(0, buffer.indexOf("\n")).trim());
        finish(isVerdict(reply) ? reply : null);
      } catch {
        finish(null);
      }
    });
    client.on("error", () => finish(null));
  });
}

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorDaemon } from "../../../daemon/src/index.ts";
import { getRunningDaemonLock, isProcessAlive } from "../../../daemon/src/lock.ts";
import { sendDaemonControl } from "../../../agent-adapters/src/hook-client.ts";

const BIN_PATH = fileURLToPath(new URL("../bin.ts", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Starts the daemon as a detached background process. The CLI itself exits right after,
 * so the daemon must not live inside this process.
 */
export async function handleStartDaemon(projectPath = process.cwd(), timeoutMs = 8000): Promise<string> {
  const root = resolve(projectPath);
  const existing = getRunningDaemonLock(root);
  if (existing) {
    return `Supervisor daemon is already running (PID: ${existing.pid}, IPC: ${existing.ipcTarget}).`;
  }

  const ctrlplaneDir = join(root, ".ctrlplane");
  if (!existsSync(ctrlplaneDir)) mkdirSync(ctrlplaneDir, { recursive: true });
  const logFd = openSync(join(ctrlplaneDir, "daemon.log"), "a");

  const child = spawn(process.execPath, [BIN_PATH, "daemon-run", "--project", root], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = getRunningDaemonLock(root);
    if (lock && lock.pid === child.pid) {
      return `Supervisor daemon started (PID: ${lock.pid}, IPC: ${lock.ipcTarget}). Log: .ctrlplane/daemon.log`;
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  return `Supervisor daemon failed to start within ${timeoutMs}ms. See .ctrlplane/daemon.log`;
}

/** Foreground entry used by the detached child. Runs until a shutdown frame or signal arrives. */
export async function handleRunDaemon(projectPath = process.cwd()): Promise<number> {
  const root = resolve(projectPath);
  const { buildProjectEngine } = await import("../../../policy-engine/src/index.ts");
  let projectEngine;
  try {
    projectEngine = await buildProjectEngine(root);
  } catch (err) {
    console.error(`[ctrlplane daemon] policy config invalid, running built-in rules only: ${String(err)}`);
  }
  const daemon = new SupervisorDaemon({ projectPath: root, projectEngine });
  const endpoint = await daemon.start();
  console.log(
    `[ctrlplane daemon] pid=${process.pid} ipc=${endpoint.path ?? `${endpoint.host}:${endpoint.port}`} started=${new Date().toISOString()}`,
  );

  await new Promise<void>((done) => {
    daemon.waitForShutdownRequest().then(done);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(sig, () => done());
    }
  });

  await daemon.stop();
  console.log(`[ctrlplane daemon] pid=${process.pid} stopped=${new Date().toISOString()}`);
  return 0;
}

export async function handleStopDaemon(projectPath = process.cwd()): Promise<string> {
  const root = resolve(projectPath);
  const existing = getRunningDaemonLock(root);
  if (!existing) {
    return "No running supervisor daemon found.";
  }

  await sendDaemonControl(existing.ipcTarget, "shutdown");
  for (let i = 0; i < 30 && isProcessAlive(existing.pid); i++) await sleep(100);

  if (isProcessAlive(existing.pid)) {
    try {
      process.kill(existing.pid);
    } catch (err) {
      return `Failed to terminate daemon (PID: ${existing.pid}): ${String(err)}`;
    }
  }

  const lockPath = join(root, ".ctrlplane", "daemon.lock");
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
  return `Supervisor daemon stopped (PID: ${existing.pid}).`;
}

export async function handleStatus(projectPath = process.cwd()): Promise<string> {
  const root = resolve(projectPath);
  const existing = getRunningDaemonLock(root);
  if (!existing) {
    return "Supervisor daemon: OFFLINE\nStatus: No active session monitored. Hooks still enforce rules in-process.";
  }

  const pong = await sendDaemonControl(existing.ipcTarget, "ping", 1000);
  const health = pong ? `responding (v${pong.stdoutMessage ?? "?"})` : "NOT RESPONDING to IPC";
  return `Supervisor daemon: RUNNING\nPID: ${existing.pid}\nIPC Endpoint: ${existing.ipcTarget}\nHealth: ${health}`;
}

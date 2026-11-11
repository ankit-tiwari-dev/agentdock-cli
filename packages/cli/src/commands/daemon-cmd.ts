import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorDaemon } from "../../../daemon/src/index.ts";
import { getRunningDaemonLock, isProcessAlive, type DaemonLock } from "../../../daemon/src/lock.ts";
import { sendDaemonControl } from "../../../agent-adapters/src/hook-client.ts";

const BIN_PATH = fileURLToPath(new URL("../bin.ts", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function lockPath(root: string): string {
  return join(root, ".ctrlplane", "daemon.lock");
}

/** Removes the lock only if it still describes `lock` (a new daemon may have replaced it meanwhile). */
function removeStaleLock(root: string, lock: DaemonLock): void {
  try {
    const current = JSON.parse(readFileSync(lockPath(root), "utf8")) as Partial<DaemonLock> | null;
    if (current?.pid === lock.pid && current?.ipcTarget === lock.ipcTarget) unlinkSync(lockPath(root));
  } catch {
    // Already gone or unreadable: nothing to remove.
  }
}

/**
 * The lock of a daemon that is running AND answers a ping on its IPC target, with its version.
 * A live PID alone proves nothing: after a crash or reboot the PID can belong to an unrelated
 * program. A lock whose daemon does not answer is stale; it is removed and null is returned, so
 * `stop` never kills a process just because its PID is in the lock.
 */
async function confirmedDaemon(root: string): Promise<{ lock: DaemonLock; version: string } | null> {
  const lock = getRunningDaemonLock(root);
  if (!lock) return null;
  const pong = await sendDaemonControl(lock.ipcTarget, "ping", 1000);
  if (pong) return { lock, version: pong.stdoutMessage ?? "?" };
  removeStaleLock(root, lock);
  return null;
}

/**
 * Starts the daemon as a detached background process. The CLI itself exits right after,
 * so the daemon must not live inside this process.
 */
export async function handleStartDaemon(projectPath = process.cwd(), timeoutMs = 8000): Promise<string> {
  const root = resolve(projectPath);
  const running = await confirmedDaemon(root);
  if (running) {
    return `Supervisor daemon is already running (PID: ${running.lock.pid}, IPC: ${running.lock.ipcTarget}).`;
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
  const running = await confirmedDaemon(root);
  if (!running) {
    return "No running supervisor daemon found.";
  }
  const existing = running.lock;

  await sendDaemonControl(existing.ipcTarget, "shutdown");
  for (let i = 0; i < 30 && isProcessAlive(existing.pid); i++) await sleep(100);

  // Only reached for a PID that answered as our daemon a moment ago.
  if (isProcessAlive(existing.pid)) {
    try {
      process.kill(existing.pid);
    } catch (err) {
      return `Failed to terminate daemon (PID: ${existing.pid}): ${String(err)}`;
    }
  }

  if (existsSync(lockPath(root))) removeStaleLock(root, existing);
  return `Supervisor daemon stopped (PID: ${existing.pid}).`;
}

export async function handleStatus(projectPath = process.cwd()): Promise<string> {
  const root = resolve(projectPath);
  const running = await confirmedDaemon(root);
  if (!running) {
    return "Supervisor daemon: OFFLINE\nStatus: No active session monitored. Hooks still enforce rules in-process.";
  }
  const { lock, version } = running;
  return `Supervisor daemon: RUNNING\nPID: ${lock.pid}\nIPC Endpoint: ${lock.ipcTarget}\nHealth: responding (v${version})`;
}

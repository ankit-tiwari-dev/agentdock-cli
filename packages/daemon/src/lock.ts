import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Nearest directory at or above `start` that contains `.ctrlplane/`. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".ctrlplane"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export interface DaemonLock {
  pid: number;
  ipcTarget: string;
  startedAt?: number;
  version?: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reads the daemon lock. A lock whose process is gone is stale: it is removed and null is returned,
 * so `status` never reports a dead daemon as running.
 */
export function getRunningDaemonLock(projectPath: string): DaemonLock | null {
  const lockPath = join(projectPath, ".ctrlplane", "daemon.lock");
  if (!existsSync(lockPath)) return null;

  let lock: DaemonLock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }

  if (!isProcessAlive(lock.pid)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have cleaned it up first.
    }
    return null;
  }
  return lock;
}

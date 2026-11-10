import { SupervisorDaemon, getRunningDaemonLock } from "../../../daemon/src/index.ts";

export async function handleStartDaemon(projectPath = process.cwd()): Promise<string> {
  const existing = getRunningDaemonLock(projectPath);
  if (existing) {
    return `Supervisor daemon is already running (PID: ${existing.pid}, IPC: ${existing.ipcTarget}).`;
  }

  const daemon = new SupervisorDaemon({ projectPath });
  const endpoint = await daemon.start();
  const target = endpoint.path || `${endpoint.host}:${endpoint.port}`;

  return `Supervisor daemon started successfully (PID: ${process.pid}, IPC: ${target}).`;
}

export async function handleStopDaemon(projectPath = process.cwd()): Promise<string> {
  const existing = getRunningDaemonLock(projectPath);
  if (!existing) {
    return "No running supervisor daemon found.";
  }

  try {
    process.kill(existing.pid, "SIGTERM");
    return `Sent shutdown signal to supervisor daemon (PID: ${existing.pid}).`;
  } catch (err) {
    return `Failed to terminate daemon: ${String(err)}`;
  }
}

export function handleStatus(projectPath = process.cwd()): string {
  const existing = getRunningDaemonLock(projectPath);
  if (!existing) {
    return "Supervisor daemon: OFFLINE\nStatus: No active session monitored.";
  }

  return `Supervisor daemon: RUNNING\nPID: ${existing.pid}\nIPC Endpoint: ${existing.ipcTarget}\nStatus: Monitoring agent lifecycle hooks.`;
}


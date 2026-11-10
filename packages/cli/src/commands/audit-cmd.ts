import { StorageEngine } from "../../../storage/src/index.ts";
import { join } from "node:path";

export function handleAuditCommand(subcommand: string, args: string[], projectPath = process.cwd()): string {
  const dbPath = join(projectPath, ".ctrlplane", "audit.db");
  const storage = new StorageEngine(dbPath);

  try {
    if (subcommand === "list" || !subcommand) {
      const sessions = storage.listSessions(10);
      if (sessions.length === 0) {
        return "No agent sessions recorded in audit database.";
      }

      const rows = sessions.map(
        (s) =>
          `• [${s.status.toUpperCase()}] ${s.id} | Agent: ${s.agentType} | Branch: ${s.gitBranch} | Started: ${new Date(s.startedAt).toLocaleTimeString()}`
      );
      return ["Recent Agent Sessions:", ...rows].join("\n");
    }

    if (subcommand === "show") {
      const sessionId = args[0];
      if (!sessionId) {
        return "Error: Provide a session ID (e.g., 'ctrlplane audit show <id>').";
      }

      const events = storage.listEventsForSession(sessionId);
      if (events.length === 0) {
        return `No events found for session '${sessionId}'.`;
      }

      const rows = events.map(
        (e) =>
          `  #${e.sequenceNum} [${e.eventType}] tool=${e.toolName ?? "none"} verdict=${e.policyVerdict ?? "N/A"}`
      );
      return [`Audit Timeline for ${sessionId} (${events.length} events):`, ...rows].join("\n");
    }

    return `Unknown audit subcommand '${subcommand}'. Available: list, show <id>.`;
  } finally {
    storage.close();
  }
}


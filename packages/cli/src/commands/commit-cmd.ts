import { commitAgentTurn } from "../../../git-analyzer/src/agent-commit-tracker.ts";

export function handleCommitCommand(subjectArgs: string[]): string {
  const subject = subjectArgs.join(" ").trim();
  if (!subject) {
    return "Usage: ctrlplane commit \"<commit subject>\"\nExample: ctrlplane commit \"Implement authentication middleware\"";
  }

  try {
    const sha = commitAgentTurn({
      cwd: process.cwd(),
      subject,
      metadata: {
        agentId: `manual_${Date.now()}`,
        agentType: "developer",
        modelName: "user-guided",
      },
    });

    return `✓ Created traceable agent commit: ${sha.slice(0, 7)}: ${subject}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to create agent commit: ${msg}`;
  }
}


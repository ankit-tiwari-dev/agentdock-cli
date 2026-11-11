import { commitAgentTurn } from "../../../git-analyzer/src/agent-commit-tracker.ts";
import type { CommandResult } from "./policies-cmd.ts";

export function handleCommitCommand(subjectArgs: string[]): CommandResult {
  const subject = subjectArgs.join(" ").trim();
  if (!subject) {
    return {
      output:
        'Usage: ctrlplane commit "<commit subject>"\nExample: ctrlplane commit "Implement authentication middleware"',
      exitCode: 1,
    };
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

    return { output: `✓ Created traceable agent commit: ${sha.slice(0, 7)}: ${subject}`, exitCode: 0 };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to create agent commit: ${msg}`, exitCode: 1 };
  }
}

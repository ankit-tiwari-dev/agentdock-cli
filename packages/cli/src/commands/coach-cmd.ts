import { evaluatePromptQuality } from "../../../explanation/src/prompt-coach.ts";
import type { CommandResult } from "./policies-cmd.ts";

export function handleCoachCommand(promptArgs: string[]): CommandResult {
  const prompt = promptArgs.join(" ").trim();
  if (!prompt) {
    return {
      output: 'Usage: ctrlplane coach "<prompt text>"\nExample: ctrlplane coach "Please update auth.ts and run tests"',
      exitCode: 1,
    };
  }

  const feedback = evaluatePromptQuality(prompt);

  const lines = [
    `=== AgentDock Prompt Coach ===`,
    `Score:  ${feedback.score} / 100 (${feedback.rating})`,
    `Prompt: "${feedback.prompt}"`,
    "",
  ];

  if (feedback.detectedIssues.length > 0) {
    lines.push("⚠️  Detected Issues:");
    for (const issue of feedback.detectedIssues) {
      lines.push(`  • ${issue}`);
    }
    lines.push("");
  }

  if (feedback.recommendations.length > 0) {
    lines.push("💡 Recommendations:");
    for (const rec of feedback.recommendations) {
      lines.push(`  • ${rec}`);
    }
    lines.push("");
  }

  if (feedback.rating === "HIGH_RISK" || feedback.rating === "NEEDS_IMPROVEMENT") {
    lines.push("✨ Suggested Refinement Template:");
    lines.push(feedback.suggestedPrompt);
  }

  return { output: lines.join("\n"), exitCode: 0 };
}

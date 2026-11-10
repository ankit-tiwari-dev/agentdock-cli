/**
 * Prompt Coach and Developer Efficiency Advisor.
 * Adapted with enhancements from aGiTrack (Apache License 2.0).
 * Analyzes developer prompts to eliminate agent confusion, token burns, and regression loops.
 */

export interface PromptCoachingFeedback {
  prompt: string;
  score: number; // 0 - 100
  rating: "EXCELLENT" | "GOOD" | "NEEDS_IMPROVEMENT" | "HIGH_RISK";
  detectedIssues: string[];
  recommendations: string[];
  suggestedPrompt: string;
}

export function evaluatePromptQuality(prompt: string): PromptCoachingFeedback {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  const issues: string[] = [];
  const recommendations: string[] = [];
  let score = 85;

  // 1. Ultra-short or under-specified prompt
  if (trimmed.length < 15) {
    issues.push("Prompt is too brief (< 15 characters). Coding agents often guess blindly on short prompts.");
    recommendations.push("Specify the exact file, expected output, and target behavior.");
    score -= 40;
  } else if (trimmed.length < 40 && !lower.includes(".")) {
    issues.push("Prompt lacks file references or error detail.");
    recommendations.push("Include the path to the target file (e.g., `src/auth.ts`) or the error message.");
    score -= 20;
  }

  // 2. Frustration / repeated loop signals
  if (
    lower.includes("still failing") ||
    lower.includes("you broke") ||
    lower.includes("not working") ||
    lower.includes("same mistake")
  ) {
    issues.push("Frustration phrasing detected. Agents struggle to self-correct without specific diagnostic logs.");
    recommendations.push("Paste the exact terminal error output or stack trace rather than saying 'it failed'.");
    score -= 25;
  }

  // 3. Multi-task overload
  const taskSeparators = lower.split(/and also|in addition|furthermore|, and /);
  if (taskSeparators.length >= 4) {
    issues.push("Multi-task overload: Prompt combines 4+ distinct tasks in a single turn.");
    recommendations.push("Split into sequential turns: let the agent complete and test task 1 before assigning task 2.");
    score -= 20;
  }

  // 4. Test grounding check
  const mentionsTests =
    lower.includes("test") ||
    lower.includes("spec") ||
    lower.includes("verify") ||
    lower.includes("criterion") ||
    lower.includes("assert");

  if (!mentionsTests && trimmed.length > 50) {
    recommendations.push("Tip: Add an acceptance test instruction: 'Run `npm test` to verify the fix passes.'");
    score -= 5;
  }

  // Normalize score
  score = Math.max(10, Math.min(100, score));

  let rating: PromptCoachingFeedback["rating"] = "EXCELLENT";
  if (score < 50) rating = "HIGH_RISK";
  else if (score < 70) rating = "NEEDS_IMPROVEMENT";
  else if (score < 85) rating = "GOOD";

  // Generate refined template
  let suggestedPrompt = trimmed;
  if (rating === "HIGH_RISK" || rating === "NEEDS_IMPROVEMENT") {
    suggestedPrompt = `Objective: ${trimmed}\nTarget Files: [specify file path]\nAcceptance Criteria:\n1. [Expected outcome]\n2. Run tests to confirm zero regressions.`;
  }

  return {
    prompt: trimmed,
    score,
    rating,
    detectedIssues: issues,
    recommendations,
    suggestedPrompt,
  };
}

export interface PromptCoachingFeedback {
  prompt: string;
  score: number;
  rating: "EXCELLENT" | "GOOD" | "NEEDS_IMPROVEMENT" | "HIGH_RISK";
  detectedIssues: string[];
  recommendations: string[];
  suggestedPrompt: string;
}

const MIN_ACTIONABLE_WORDS = 6;
const MIN_ACTIONABLE_CHARS = 25;
const VERIFICATION_TIP_MIN_WORDS = 12;
const MULTI_TASK_THRESHOLD = 3;

const SOURCE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|hpp|swift|json|ya?ml|toml|ini|env|md|css|scss|html|sql|sh|ps1|proto|graphql|tf|lock";
const FILE_NAME = new RegExp(`\\b[\\w.-]+\\.(?:${SOURCE_EXTENSIONS})\\b`, "i");
const SLASHED_PATH = /(?:^|\s)\.{0,2}\/?[\w.-]+\/[\w./-]+/;
const CODE_SPAN = /`[^`\n]+`/;

const ERROR_SIGNALS: RegExp[] = [
  /```/,
  /\b[A-Z]\w*(?:Error|Exception)\b/,
  /\b(?:error|exception|panic|traceback|fatal)\s*:/i,
  /\bat\s+\S+\s+\(?[^\s()]+:\d+/,
  /\b[\w.-]+:\d+:\d+\b/,
  /\bexit(?:ed)?\s+(?:with\s+)?code\s+\d+/i,
  /\bE[A-Z]{3,}\b/,
  /\bstack\s*trace\s*:/i,
  /"[^"\n]{15,}"|'[^'\n]{15,}'/,
];

const OUTCOME_SIGNALS =
  /\b(?:should|expect(?:ed|s)?|so that|must|ensure|instead of|returns?|result(?:s)? in|output|until|criteria)\b/i;

const VERIFICATION_SIGNALS =
  /\b(?:tests?|spec|verify|verified|assert(?:ion)?s?|npm|pnpm|yarn|npx|pytest|jest|vitest|cargo|go test|lint|typecheck|acceptance|criteria|expected output|passes|green|reproduce)\b/i;

const VAGUE_WORDS = /\b(?:this|that|it|stuff|things?|something|somehow|whatever|etc|better|properly|work(?:ing)?)\b/i;

const FRUSTRATION_PHRASES: string[] = [
  "still failing",
  "still fails",
  "still broken",
  "still not working",
  "still doesn't work",
  "still does not work",
  "still wrong",
  "not working",
  "doesn't work",
  "does not work",
  "isn't working",
  "is not working",
  "keeps failing",
  "keeps breaking",
  "nothing works",
  "you broke",
  "broke it",
  "same mistake",
  "same problem again",
  "same error again",
  "try again",
  "why does it keep",
  "wtf",
];

const TASK_VERBS = new Set([
  "fix",
  "add",
  "update",
  "refactor",
  "rename",
  "remove",
  "delete",
  "create",
  "implement",
  "migrate",
  "rewrite",
  "build",
  "change",
  "move",
  "write",
  "upgrade",
  "convert",
  "replace",
  "optimize",
  "document",
  "deploy",
]);

interface PromptSignals {
  wordCount: number;
  hasFileReference: boolean;
  hasErrorEvidence: boolean;
  hasExpectedOutcome: boolean;
  hasVerification: boolean;
  isVague: boolean;
  frustrationPhrase?: string;
  taskCount: number;
}

function countTaskSegments(prompt: string): number {
  // Splits on sentence ends, list items and chaining words; the dot inside "src/auth.ts" is not a sentence end.
  const segments = prompt
    .split(/[.!?;]+(?=\s|$)|\n+|\b(?:and also|also|and then|then|plus)\b|,\s*and\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

  let count = 0;
  for (const segment of segments) {
    const words = segment.toLowerCase().match(/[a-z]+/g) ?? [];
    if (words.some((w) => TASK_VERBS.has(w))) {
      count++;
    }
  }
  return count;
}

function findFrustration(lowered: string): string | undefined {
  return FRUSTRATION_PHRASES.find((phrase) => lowered.includes(phrase));
}

function readSignals(prompt: string): PromptSignals {
  const lowered = prompt.toLowerCase();
  const hasFileReference = FILE_NAME.test(prompt) || SLASHED_PATH.test(prompt) || CODE_SPAN.test(prompt);
  return {
    wordCount: prompt.split(/\s+/).filter(Boolean).length,
    hasFileReference,
    hasErrorEvidence: ERROR_SIGNALS.some((re) => re.test(prompt)),
    hasExpectedOutcome: OUTCOME_SIGNALS.test(prompt),
    hasVerification: VERIFICATION_SIGNALS.test(prompt),
    isVague: !hasFileReference && VAGUE_WORDS.test(prompt),
    frustrationPhrase: findFrustration(lowered),
    taskCount: countTaskSegments(prompt),
  };
}

function rate(score: number): PromptCoachingFeedback["rating"] {
  if (score >= 80) return "EXCELLENT";
  if (score >= 60) return "GOOD";
  if (score >= 40) return "NEEDS_IMPROVEMENT";
  return "HIGH_RISK";
}

function buildTemplate(prompt: string, signals: PromptSignals): string {
  const objective =
    signals.taskCount >= MULTI_TASK_THRESHOLD ? `${prompt} (pick ONE of these tasks for this prompt)` : prompt;
  return [
    `Objective: ${objective}`,
    "Context: <files, functions or modules involved, e.g. src/auth.ts>",
    "Evidence: <exact error message, stack trace or failing output>",
    "Expected outcome: <what should be true when the change is done>",
    "Verification: <test or command that proves it, e.g. npm test tests/auth.test.ts>",
    "Constraints: <what must not change>",
  ].join("\n");
}

export function evaluatePromptQuality(prompt: string): PromptCoachingFeedback {
  const text = prompt.trim();
  const signals = readSignals(text);
  const detectedIssues: string[] = [];
  const recommendations: string[] = [];
  let score = 100;

  const hasAnchor = signals.hasFileReference || signals.hasErrorEvidence || signals.hasExpectedOutcome;
  const tooBrief = signals.wordCount < MIN_ACTIONABLE_WORDS || text.length < MIN_ACTIONABLE_CHARS;

  if (tooBrief) {
    score -= 45;
    detectedIssues.push("Prompt is too brief for an agent to act on without guessing.");
    recommendations.push("State the goal in a full sentence: what to change, where, and why.");
  }

  if (!hasAnchor) {
    score -= 25;
    detectedIssues.push("No concrete anchor: no file, error message or expected outcome is named.");
    recommendations.push("Name the file or function to change and describe the result you expect.");
  }

  if (signals.isVague) {
    score -= 10;
    detectedIssues.push('Vague references ("this", "it", "stuff") without saying what they point to.');
    recommendations.push("Replace pronouns with the exact file, function or behaviour you mean.");
  }

  if (signals.frustrationPhrase && !signals.hasErrorEvidence) {
    score -= 20;
    detectedIssues.push(
      `Frustration phrasing without evidence ("${signals.frustrationPhrase}"): the agent cannot see what failed.`,
    );
    recommendations.push("Paste the exact error message or stack trace and the command that produced it.");
  }

  if (signals.taskCount >= MULTI_TASK_THRESHOLD) {
    score -= 15;
    detectedIssues.push(`Several separate tasks (${signals.taskCount}) are packed into one prompt.`);
    recommendations.push("Split this into one prompt per task and verify each before starting the next.");
  }

  if (!tooBrief && signals.wordCount >= VERIFICATION_TIP_MIN_WORDS && !signals.hasVerification) {
    score -= 10;
    detectedIssues.push("No way to verify the result: no test, command, criterion or expected output.");
    recommendations.push("Tip: add the test or command that proves the change works, e.g. `npm test <file>`.");
  }

  score = Math.max(0, Math.min(100, score));
  let rating = rate(score);
  if (tooBrief && !hasAnchor) {
    rating = "HIGH_RISK";
  } else if (!hasAnchor && (rating === "EXCELLENT" || rating === "GOOD")) {
    rating = "NEEDS_IMPROVEMENT";
  }

  const needsRewrite = rating === "HIGH_RISK" || rating === "NEEDS_IMPROVEMENT";
  return {
    prompt: text,
    score,
    rating,
    detectedIssues,
    recommendations,
    suggestedPrompt: needsRewrite ? buildTemplate(text, signals) : text,
  };
}

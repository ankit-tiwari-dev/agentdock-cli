import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePromptQuality } from "../src/prompt-coach.ts";

test("Prompt Coach - flags ultra-short ambiguous prompts as HIGH_RISK", () => {
  const result = evaluatePromptQuality("fix this");
  assert.equal(result.rating, "HIGH_RISK");
  assert.ok(result.score < 50);
  assert.ok(result.detectedIssues.some((i) => i.includes("too brief")));
  assert.ok(result.suggestedPrompt.includes("Objective: fix this"));
});

test("Prompt Coach - detects frustration phrases and advises pasting logs", () => {
  const result = evaluatePromptQuality("It is still failing with the same mistake you made before!");
  assert.ok(result.detectedIssues.some((i) => i.includes("Frustration phrasing")));
  assert.ok(result.recommendations.some((r) => r.includes("stack trace")));
});

test("Prompt Coach - rates detailed test-grounded prompts as EXCELLENT", () => {
  const result = evaluatePromptQuality(
    "Please update src/auth.ts to check token expiration. Verify with `npm test tests/auth.test.ts` to ensure no regressions.",
  );
  assert.equal(result.rating, "EXCELLENT");
  assert.ok(result.score >= 80);
});

test("Prompt Coach - returns the trimmed prompt unchanged when no rewrite is needed", () => {
  const raw = "   Please update src/auth.ts to check token expiration. Verify with `npm test tests/auth.test.ts`.  ";
  const result = evaluatePromptQuality(raw);
  assert.equal(result.prompt, raw.trim());
  assert.equal(result.suggestedPrompt, raw.trim());
  assert.deepEqual(result.detectedIssues, []);
});

test("Prompt Coach - a prompt with no file, error or expected outcome is flagged as unanchored", () => {
  const result = evaluatePromptQuality(
    "Can you make the dashboard look nicer and feel faster for everyone who uses it",
  );
  assert.ok(result.detectedIssues.some((i) => i.includes("No concrete anchor")));
  assert.ok(result.detectedIssues.some((i) => i.includes("Vague references")));
  assert.ok(result.rating === "NEEDS_IMPROVEMENT" || result.rating === "HIGH_RISK");
  assert.ok(result.suggestedPrompt.startsWith("Objective: Can you make the dashboard"));
  assert.ok(result.suggestedPrompt.includes("Verification:"));
});

test("Prompt Coach - an unanchored prompt is never rated better than NEEDS_IMPROVEMENT", () => {
  const result = evaluatePromptQuality("Please improve how the dashboard page loads for customers");
  assert.ok(result.detectedIssues.some((i) => i.includes("No concrete anchor")));
  assert.equal(result.rating, "NEEDS_IMPROVEMENT");
  assert.ok(result.suggestedPrompt.startsWith("Objective: "));
});

test("Prompt Coach - frustration that comes with the actual error is not flagged", () => {
  const result = evaluatePromptQuality(
    "Still failing: TypeError: Cannot read properties of undefined (reading 'id') at getUser (src/user.ts:42:7)",
  );
  assert.ok(!result.detectedIssues.some((i) => i.includes("Frustration phrasing")));
});

test("Prompt Coach - 'you broke it' without evidence is frustration", () => {
  const result = evaluatePromptQuality("You broke it again, the login page does not work anymore after your change");
  assert.ok(result.detectedIssues.some((i) => i.includes("Frustration phrasing")));
  assert.ok(result.recommendations.some((r) => r.includes("exact error")));
});

test("Prompt Coach - several unrelated tasks in one prompt are advised to be split", () => {
  const result = evaluatePromptQuality(
    "Fix the login bug in src/auth.ts, and also add dark mode to the settings page. Then rename the User model to Account and update the README.",
  );
  assert.ok(result.detectedIssues.some((i) => i.includes("Several separate tasks")));
  assert.ok(result.recommendations.some((r) => r.includes("Split")));
});

test("Prompt Coach - a single task with a verification step is not treated as several tasks", () => {
  const result = evaluatePromptQuality(
    "Fix the null check in src/user.ts so that getUser returns undefined for a missing id, then run `npm test`.",
  );
  assert.ok(!result.detectedIssues.some((i) => i.includes("Several separate tasks")));
});

test("Prompt Coach - a longer prompt with no way to verify gets a verification tip", () => {
  const result = evaluatePromptQuality(
    "Please refactor the payment retry logic in src/billing/retry.ts so that it uses exponential backoff with jitter.",
  );
  assert.ok(result.detectedIssues.some((i) => i.includes("No way to verify")));
  assert.ok(result.recommendations.some((r) => r.startsWith("Tip:")));
});

test("Prompt Coach - a short prompt does not get the verification tip", () => {
  const result = evaluatePromptQuality("Rename getUser to fetchUser in src/user.ts");
  assert.ok(!result.detectedIssues.some((i) => i.includes("No way to verify")));
});

test("Prompt Coach - score stays within 0 to 100", () => {
  for (const prompt of ["", "it", "still not working!!! you broke it", "x".repeat(500)]) {
    const { score } = evaluatePromptQuality(prompt);
    assert.ok(score >= 0 && score <= 100, `score ${score} for ${JSON.stringify(prompt.slice(0, 20))}`);
  }
});

test("regression: task counting answers in linear time on a long run of punctuation", () => {
  const start = performance.now();
  evaluatePromptQuality(`fix ${"!".repeat(100_000)}x`);
  // The coach runs on every prompt inside the hook's 1500 ms budget; 300 ms leaves room for a slow CI runner.
  assert.ok(performance.now() - start < 300);

  const split = evaluatePromptQuality("Fix the login bug!! Then add a test?! Also update the docs... and deploy it");
  assert.ok(split.detectedIssues.some((i) => i.includes("Several separate tasks (4)")));
  const oneTask = evaluatePromptQuality("Fix the crash in src/auth.ts!!!x when the token is empty");
  assert.ok(!oneTask.detectedIssues.some((i) => i.includes("Several separate tasks")));
});

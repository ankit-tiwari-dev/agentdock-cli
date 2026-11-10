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
    "Please update src/auth.ts to check token expiration. Verify with `npm test tests/auth.test.ts` to ensure no regressions."
  );
  assert.equal(result.rating, "EXCELLENT");
  assert.ok(result.score >= 80);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  getModelPricing,
  calculateTurnCost,
  formatCostUsd,
} from "../src/token-pricing.ts";

test("Token Pricing - recognizes major models and calculates accurate costs", () => {
  const claudePricing = getModelPricing("claude-3-5-sonnet");
  assert.equal(claudePricing.inputPerMTok, 3.0);
  assert.equal(claudePricing.outputPerMTok, 15.0);

  const geminiPricing = getModelPricing("gemini-1.5-pro");
  assert.equal(geminiPricing.inputPerMTok, 1.25);
  assert.equal(geminiPricing.outputPerMTok, 5.0);

  const ollamaPricing = getModelPricing("ollama/deepseek-r1");
  assert.equal(ollamaPricing.inputPerMTok, 0.0);
  assert.equal(ollamaPricing.outputPerMTok, 0.0);
});

test("Token Pricing - calculateTurnCost computes exact USD costs", () => {
  // 1,000 input tokens and 500 output tokens on Claude 3.5 Sonnet
  // Input: 1000/1M * 3 = $0.003
  // Output: 500/1M * 15 = $0.0075
  // Total: $0.0105
  const result = calculateTurnCost({
    modelName: "claude-3-5-sonnet",
    inputTokens: 1000,
    outputTokens: 500,
  });

  assert.equal(result.totalTokens, 1500);
  assert.equal(result.costUsd, 0.0105);
  assert.equal(result.formattedCost, "$0.0105");
});

test("Token Pricing - formatCostUsd formats zero and tiny costs properly", () => {
  assert.equal(formatCostUsd(0), "$0.00");
  assert.equal(formatCostUsd(0.00005), "<$0.0001");
  assert.equal(formatCostUsd(0.0034), "$0.0034");
  assert.equal(formatCostUsd(1.2345), "$1.23");
});

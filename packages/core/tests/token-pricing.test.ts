import test from "node:test";
import assert from "node:assert/strict";
import {
  getModelPricing,
  calculateTurnCost,
  formatCostUsd,
  normalizeModelName,
  DEFAULT_MODEL_PRICING,
  MODEL_PRICING_CATALOG,
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

test("Token Pricing - a dated model id prices as the longest matching catalog key", () => {
  assert.deepEqual(getModelPricing("claude-sonnet-4-5-20250929"), MODEL_PRICING_CATALOG["claude-sonnet-4-5"]);
  assert.deepEqual(getModelPricing("claude-opus-4-5-20251101"), MODEL_PRICING_CATALOG["claude-opus-4-5"]);
  assert.deepEqual(getModelPricing("claude-opus-4-20250514"), MODEL_PRICING_CATALOG["claude-opus-4"]);
  // claude-opus-5 is also a prefix of claude-opus-5-5, so only the longest match gives the right price.
  assert.equal(getModelPricing("claude-opus-5-5").inputPerMTok, 4);
  assert.equal(getModelPricing("claude-opus-5-20260101").inputPerMTok, 5);
  assert.deepEqual(getModelPricing("gpt-4o-mini-2024-07-18"), MODEL_PRICING_CATALOG["gpt-4o-mini"]);
});

test("Token Pricing - normalizes case, whitespace and provider prefixes", () => {
  assert.equal(normalizeModelName("  Anthropic/Claude-3-5-Sonnet "), "claude-3-5-sonnet");
  assert.equal(normalizeModelName("google/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(normalizeModelName("openai/gpt-4o"), "gpt-4o");
  assert.equal(normalizeModelName("ollama/qwen2.5-coder"), "ollama/qwen2.5-coder");
  assert.deepEqual(getModelPricing("OpenAI/GPT-4o"), MODEL_PRICING_CATALOG["gpt-4o"]);
});

test("Token Pricing - unknown or missing models fall back to the default price", () => {
  assert.deepEqual(getModelPricing("some-unknown-model"), DEFAULT_MODEL_PRICING);
  assert.deepEqual(getModelPricing(), DEFAULT_MODEL_PRICING);
  assert.equal(calculateTurnCost({}).model, "claude-3-5-sonnet");
});

test("Token Pricing - cache reads are priced only when the model has a cache rate", () => {
  const cached = calculateTurnCost({ modelName: "claude-3-5-sonnet", cacheReadTokens: 1_000_000 });
  assert.equal(cached.costUsd, 0.3);
  assert.equal(cached.totalTokens, 1_000_000);

  const uncached = calculateTurnCost({
    modelName: "gemini-2.0-flash",
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  });
  assert.equal(uncached.costUsd, 0.1);
  assert.equal(uncached.totalTokens, 2_000_000);
});

test("Token Pricing - negative token counts count as zero", () => {
  const result = calculateTurnCost({ modelName: "gpt-4o", inputTokens: -500, outputTokens: 1_000_000 });
  assert.equal(result.inputTokens, 0);
  assert.equal(result.totalTokens, 1_000_000);
  assert.equal(result.costUsd, 10);
  assert.equal(result.formattedCost, "$10.00");
});

/**
 * Token pricing and spend estimation engine.
 * Adapted with enhancements from Builderz Labs Mission Control (MIT License).
 */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export const DEFAULT_MODEL_PRICING: ModelPricing = {
  inputPerMTok: 3.0,
  outputPerMTok: 15.0,
};

export const MODEL_PRICING_CATALOG: Record<string, ModelPricing> = {
  // Anthropic Claude
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  "claude-3-5-sonnet": { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadPerMTok: 0.3 },
  "claude-3-7-sonnet": { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadPerMTok: 0.3 },
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-4": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-sonnet-4-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-opus-4": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "claude-opus-4-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },

  // Google Gemini
  "gemini-1.5-flash": { inputPerMTok: 0.075, outputPerMTok: 0.3, cacheReadPerMTok: 0.01875 },
  "gemini-1.5-pro": { inputPerMTok: 1.25, outputPerMTok: 5.0, cacheReadPerMTok: 0.3125 },
  "gemini-2.0-flash": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 5.0 },

  // OpenAI
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10.0, cacheReadPerMTok: 1.25 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
  "o1": { inputPerMTok: 15.0, outputPerMTok: 60.0 },
  "o3-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },

  // Open Source / Local Runtimes (Ollama, vLLM, LMStudio)
  "ollama/deepseek-r1": { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  "ollama/qwen2.5-coder": { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  "deepseek-r1": { inputPerMTok: 0.55, outputPerMTok: 2.19 },
};

export function normalizeModelName(modelName: string): string {
  const clean = modelName.trim().toLowerCase();
  // Strip provider prefixes if present (e.g., anthropic/claude-3-5-sonnet -> claude-3-5-sonnet)
  return clean.replace(/^(anthropic|google|openai)\//, "");
}

export function getModelPricing(modelName?: string): ModelPricing {
  if (!modelName) return DEFAULT_MODEL_PRICING;
  const normalized = normalizeModelName(modelName);

  if (MODEL_PRICING_CATALOG[normalized]) {
    return MODEL_PRICING_CATALOG[normalized];
  }

  // Prefix matching fallback
  for (const [key, pricing] of Object.entries(MODEL_PRICING_CATALOG)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) {
      return pricing;
    }
  }

  return DEFAULT_MODEL_PRICING;
}

export interface CostCalculationParams {
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface CostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  formattedCost: string;
}

export function calculateTurnCost(params: CostCalculationParams): CostBreakdown {
  const model = params.modelName ?? "claude-3-5-sonnet";
  const pricing = getModelPricing(model);

  const inputTokens = Math.max(0, params.inputTokens ?? 0);
  const outputTokens = Math.max(0, params.outputTokens ?? 0);
  const cacheReadTokens = Math.max(0, params.cacheReadTokens ?? 0);

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;
  const cacheCost = pricing.cacheReadPerMTok ? (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok : 0;

  const costUsd = Number((inputCost + outputCost + cacheCost).toFixed(6));
  const totalTokens = inputTokens + outputTokens + cacheReadTokens;

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    costUsd,
    formattedCost: formatCostUsd(costUsd),
  };
}

export function formatCostUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.0001) return `<$0.0001`;
  if (amount < 0.1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

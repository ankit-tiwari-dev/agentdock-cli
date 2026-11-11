export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export const DEFAULT_MODEL_PRICING: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };

const DEFAULT_MODEL_NAME = "claude-3-5-sonnet";

function price(input: number, output: number, cacheRead?: number): ModelPricing {
  return cacheRead === undefined
    ? { inputPerMTok: input, outputPerMTok: output }
    : { inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: cacheRead };
}

function claude(input: number, output: number, cacheRead: number, cacheWrite: number): ModelPricing {
  return { inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: cacheRead, cacheWritePerMTok: cacheWrite };
}

// USD per million tokens, public list prices; Claude cache writes use the 5-minute TTL rate.
export const MODEL_PRICING_CATALOG: Record<string, ModelPricing> = {
  "claude-fable-5-2": claude(8, 40, 0.2, 10),
  "claude-fable-5-1": claude(10, 50, 0.25, 12.5),
  "claude-fable-5": claude(10, 50, 1, 12.5),
  "claude-mythos-5-2": claude(8, 40, 0.2, 10),
  "claude-mythos-5-1": claude(10, 50, 0.25, 12.5),
  "claude-mythos-5": claude(10, 50, 1, 12.5),
  "claude-opus-5-5": claude(4, 20, 0.2, 5),
  "claude-opus-5": claude(5, 25, 0.5, 6.25),
  "claude-opus-4-8": claude(5, 25, 0.5, 6.25),
  "claude-opus-4-7": claude(5, 25, 0.5, 6.25),
  "claude-opus-4-6": claude(5, 25, 0.5, 6.25),
  "claude-opus-4-5": claude(5, 25, 0.5, 6.25),
  "claude-opus-4": claude(15, 75, 1.5, 18.75),
  "claude-sonnet-5-5": claude(2, 10, 0.1, 2.5),
  "claude-sonnet-5": claude(2, 10, 0.2, 2.5),
  "claude-sonnet-4-6": claude(3, 15, 0.3, 3.75),
  "claude-sonnet-4-5": claude(3, 15, 0.3, 3.75),
  "claude-sonnet-4": claude(3, 15, 0.3, 3.75),
  "claude-3-7-sonnet": claude(3, 15, 0.3, 3.75),
  "claude-3-5-sonnet": claude(3, 15, 0.3, 3.75),
  // Haiku 5.5 doubles to $0.50 / $2.50 above a 100K-token prompt; a single rate cannot express that.
  "claude-haiku-5-5": claude(0.1, 0.5, 0.01, 0.125),
  "claude-haiku-4-5": claude(1, 5, 0.1, 1.25),
  "claude-3-5-haiku": claude(0.8, 4, 0.08, 1),
  "gemini-1.5-flash": price(0.075, 0.3, 0.01875),
  "gemini-1.5-pro": price(1.25, 5, 0.3125),
  "gemini-2.0-flash": price(0.1, 0.4),
  "gemini-2.5-pro": price(1.25, 5),
  "gpt-4o": price(2.5, 10, 1.25),
  "gpt-4o-mini": price(0.15, 0.6, 0.075),
  o1: price(15, 60),
  "o3-mini": price(1.1, 4.4),
  "deepseek-r1": price(0.55, 2.19),
  "ollama/deepseek-r1": price(0, 0),
  "ollama/qwen2.5-coder": price(0, 0),
};

const PROVIDER_PREFIXES = ["anthropic/", "google/", "openai/"];

export function normalizeModelName(modelName: string): string {
  let lowered = modelName.trim().toLowerCase();
  for (const prefix of PROVIDER_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      lowered = lowered.slice(prefix.length);
      break;
    }
  }
  return (
    lowered
      // Bedrock: `us.anthropic.claude-opus-4-5-20251101-v1:0` (optional region, vendor, version suffix).
      .replace(/^(?:[a-z-]+\.)?anthropic\./, "")
      .replace(/-v\d+:\d+$/, "")
      // Vertex: `claude-opus-4-5@20251101`.
      .replace(/@.*$/, "")
  );
}

/** The catalog id a model name prices as, or undefined when the model is not in the catalog. */
export function resolveModelId(modelName?: string): string | undefined {
  if (!modelName) return undefined;
  const name = normalizeModelName(modelName);
  if (MODEL_PRICING_CATALOG[name]) return name;

  let bestKey = "";
  for (const key of Object.keys(MODEL_PRICING_CATALOG)) {
    if (name.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  return bestKey || undefined;
}

/** Catalog price for a model. An unknown model gets DEFAULT_MODEL_PRICING; use resolveModelId to tell. */
export function getModelPricing(modelName?: string): ModelPricing {
  const id = resolveModelId(modelName);
  return id ? MODEL_PRICING_CATALOG[id] : DEFAULT_MODEL_PRICING;
}

export interface CostCalculationParams {
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  formattedCost: string;
  /** True when the model is not in the catalog, so costUsd is only an estimate at the default rate. */
  unknownModel?: boolean;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function calculateTurnCost(params: CostCalculationParams): CostBreakdown {
  const model = params.modelName || DEFAULT_MODEL_NAME;
  const pricing = getModelPricing(model);
  const inputTokens = nonNegative(params.inputTokens);
  const outputTokens = nonNegative(params.outputTokens);
  const cacheReadTokens = nonNegative(params.cacheReadTokens);
  const cacheWriteTokens = nonNegative(params.cacheWriteTokens);

  const rawCost =
    (inputTokens / 1e6) * pricing.inputPerMTok +
    (outputTokens / 1e6) * pricing.outputPerMTok +
    (cacheReadTokens / 1e6) * (pricing.cacheReadPerMTok ?? 0) +
    (cacheWriteTokens / 1e6) * (pricing.cacheWritePerMTok ?? 0);
  const costUsd = Math.round(rawCost * 1e6) / 1e6;

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd,
    formattedCost: formatCostUsd(costUsd),
    unknownModel: resolveModelId(model) === undefined,
  };
}

export function formatCostUsd(amount: number): string {
  if (amount === 0) {
    return "$0.00";
  }
  if (amount < 0.0001) {
    return "<$0.0001";
  }
  if (amount < 0.1) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

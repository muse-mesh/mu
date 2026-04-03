// ── Model Pricing (per 1M tokens, USD) ─────────────────────────────

import { getModelInfo } from './models.js';

const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'o3': { input: 2.00, output: 8.00 },
  'o4-mini': { input: 1.10, output: 4.40 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
};

function getModelPricing(model: string): { input: number; output: number } | null {
  // Try dynamic model registry first (OpenRouter data — per-token → per-1M)
  const info = getModelInfo(model);
  if (info) {
    return {
      input: info.pricing.prompt * 1_000_000,
      output: info.pricing.completion * 1_000_000,
    };
  }

  if (PRICING[model]) return PRICING[model];
  const lower = model.toLowerCase();
  for (const [key, value] of Object.entries(PRICING)) {
    if (lower.includes(key.toLowerCase())) return value;
  }
  return null;
}

// ── Cost Tracker ──────────────────────────────────────────────────

export interface CostTracker {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  gatewayReportedCostUsd: number;
  limitUsd: number;
  model: string;
  isOverBudget(): boolean;
  isNearBudget(): boolean;
  addUsage(inputTokens: number, outputTokens: number): void;
  addGatewayCost(cost: number): void;
  getCost(): number;
}

export function createCostTracker(model: string, limitUsd: number): CostTracker {
  const pricing = getModelPricing(model);

  const tracker: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
    gatewayReportedCostUsd: 0,
    limitUsd,
    model,

    addUsage(inputTokens: number, outputTokens: number) {
      tracker.totalInputTokens += inputTokens;
      tracker.totalOutputTokens += outputTokens;
      if (pricing) {
        tracker.estimatedCostUsd =
          (tracker.totalInputTokens / 1_000_000) * pricing.input +
          (tracker.totalOutputTokens / 1_000_000) * pricing.output;
      }
    },

    addGatewayCost(cost: number) {
      tracker.gatewayReportedCostUsd += cost;
    },

    getCost(): number {
      // Prefer gateway-reported cost when available
      return tracker.gatewayReportedCostUsd > 0
        ? tracker.gatewayReportedCostUsd
        : tracker.estimatedCostUsd;
    },

    isOverBudget(): boolean {
      if (limitUsd <= 0) return false;
      return tracker.getCost() >= limitUsd;
    },

    isNearBudget(): boolean {
      if (limitUsd <= 0) return false;
      return tracker.getCost() >= limitUsd * 0.8;
    },
  };

  return tracker;
}

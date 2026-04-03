// ── Context Window Sizes ───────────────────────────────────────────

import { getModelInfo } from './models.js';

const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'o3': 200_000,
  'o4-mini': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-opus-4-20250514': 200_000,
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
};

const DEFAULT_CONTEXT_WINDOW = 32_000;

export function getContextWindow(model: string): number {
  // Try dynamic model registry first (OpenRouter data)
  const info = getModelInfo(model);
  if (info) return info.contextLength;

  // Direct match
  if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model];
  // Partial match (e.g. "z-ai/glm-5v-turbo" → check "glm")
  const lower = model.toLowerCase();
  for (const [key, value] of Object.entries(CONTEXT_WINDOWS)) {
    if (lower.includes(key.toLowerCase())) return value;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ── Token Estimation ───────────────────────────────────────────────

// Rough heuristic: ~4 characters per token for English text
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

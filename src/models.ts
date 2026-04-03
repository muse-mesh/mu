// ── OpenRouter Model Registry ──────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  pricing: { prompt: number; completion: number }; // per-token USD
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

let cachedModels: ModelInfo[] = [];

function extractProvider(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : id;
}

function parseModels(data: OpenRouterModel[]): ModelInfo[] {
  return data
    .filter((m) => {
      const prompt = Number(m.pricing?.prompt);
      const completion = Number(m.pricing?.completion);
      // Exclude router/negative-priced entries
      return !isNaN(prompt) && !isNaN(completion) && prompt >= 0 && completion >= 0;
    })
    .map((m) => ({
      id: m.id,
      name: m.name,
      provider: extractProvider(m.id),
      contextLength: m.context_length,
      pricing: {
        prompt: Number(m.pricing.prompt),
        completion: Number(m.pricing.completion),
      },
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);
  const json = await res.json();
  cachedModels = parseModels(json.data ?? []);
  return cachedModels;
}

export function getCachedModels(): ModelInfo[] {
  return cachedModels;
}

/** Lookup a single model's info from cache */
export function getModelInfo(modelId: string): ModelInfo | undefined {
  return cachedModels.find((m) => m.id === modelId);
}

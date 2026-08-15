export type ProviderProtocol = "openai" | "anthropic" | "gemini";
export type ModelTier = "flagship" | "balanced" | "fast" | "reasoning";

export interface ModelCatalogEntry {
  readonly provider: "OpenAI" | "Anthropic" | "Google Gemini";
  readonly protocol: ProviderProtocol;
  readonly name: string;
  readonly model: string;
  readonly tier: ModelTier;
  readonly baseUrl: string;
}

export const modelCatalog: readonly ModelCatalogEntry[] = [
  {
    provider: "OpenAI",
    protocol: "openai",
    name: "GPT-5.4",
    model: "gpt-5.4",
    tier: "flagship",
    baseUrl: "https://api.openai.com/v1/",
  },
  {
    provider: "OpenAI",
    protocol: "openai",
    name: "GPT-5.4 mini",
    model: "gpt-5.4-mini",
    tier: "balanced",
    baseUrl: "https://api.openai.com/v1/",
  },
  {
    provider: "OpenAI",
    protocol: "openai",
    name: "GPT-5.4 nano",
    model: "gpt-5.4-nano",
    tier: "fast",
    baseUrl: "https://api.openai.com/v1/",
  },
  {
    provider: "OpenAI",
    protocol: "openai",
    name: "GPT-5.3 Codex",
    model: "gpt-5.3-codex",
    tier: "reasoning",
    baseUrl: "https://api.openai.com/v1/",
  },

  {
    provider: "Anthropic",
    protocol: "anthropic",
    name: "Claude Fable 5",
    model: "claude-fable-5",
    tier: "flagship",
    baseUrl: "https://api.anthropic.com/",
  },
  {
    provider: "Anthropic",
    protocol: "anthropic",
    name: "Claude Opus 5",
    model: "claude-opus-5",
    tier: "reasoning",
    baseUrl: "https://api.anthropic.com/",
  },
  {
    provider: "Anthropic",
    protocol: "anthropic",
    name: "Claude Sonnet 5",
    model: "claude-sonnet-5",
    tier: "balanced",
    baseUrl: "https://api.anthropic.com/",
  },
  {
    provider: "Anthropic",
    protocol: "anthropic",
    name: "Claude Haiku 4.5",
    model: "claude-haiku-4-5",
    tier: "fast",
    baseUrl: "https://api.anthropic.com/",
  },

  {
    provider: "Google Gemini",
    protocol: "gemini",
    name: "Gemini 3.7 Flash",
    model: "gemini-3.7-flash",
    tier: "flagship",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
  },
  {
    provider: "Google Gemini",
    protocol: "gemini",
    name: "Gemini 3.6 Flash",
    model: "gemini-3.6-flash",
    tier: "reasoning",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
  },
  {
    provider: "Google Gemini",
    protocol: "gemini",
    name: "Gemini 3.5 Flash",
    model: "gemini-3.5-flash",
    tier: "balanced",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
  },
  {
    provider: "Google Gemini",
    protocol: "gemini",
    name: "Gemini 3.5 Flash-Lite",
    model: "gemini-3.5-flash-lite",
    tier: "fast",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
  },
];

export function modelCatalogGroups(): ReadonlyMap<string, readonly ModelCatalogEntry[]> {
  const groups = new Map<string, ModelCatalogEntry[]>();
  for (const entry of modelCatalog) {
    const group = groups.get(entry.provider) ?? [];
    group.push(entry);
    groups.set(entry.provider, group);
  }
  return groups;
}

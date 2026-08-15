/**
 * Dynamic Model Fetcher for BYOK Providers
 * Queries official provider REST APIs for live available models, falling back to curated defaults.
 */

export const CURATED_MODELS: Record<string, string[]> = {
  google: [
    "gemini-3.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash-exp",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  anthropic: [
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "o3-mini",
    "o1",
  ],
  mistral: [
    "mistral-large-latest",
    "pixtral-large-latest",
    "codestral-latest",
    "mistral-small-latest",
  ],
};

export async function fetchLiveModels(provider: string, apiKey?: string): Promise<string[]> {
  if (!apiKey) return CURATED_MODELS[provider] ?? [];

  try {
    if (provider === "google") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        if (data.models) {
          const names = data.models
            .map((m) => m.name.replace(/^models\//, ""))
            .filter((n) => n.includes("gemini") && !n.includes("embedding") && !n.includes("imagen") && !n.includes("bidi"));
          if (names.length > 0) return Array.from(new Set(names));
        }
      }
    }

    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        if (data.data) {
          const names = data.data
            .map((m) => m.id)
            .filter((id) => (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")) && !id.includes("audio") && !id.includes("realtime"));
          if (names.length > 0) return Array.from(new Set(names)).sort();
        }
      }
    }

    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        if (data.data) {
          const names = data.data.map((m) => m.id).filter((id) => id.includes("claude"));
          if (names.length > 0) return Array.from(new Set(names));
        }
      }
    }
  } catch {}

  return CURATED_MODELS[provider] ?? [];
}

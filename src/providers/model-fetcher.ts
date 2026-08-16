/**
 * Model lists for the `/connector` picker.
 *
 * The catalog already knows every model each provider publishes, so this only
 * covers the cases where the *account* decides the answer: an OpenRouter or AI
 * Gateway key exposes a different set per plan, a local Ollama serves whatever
 * has been pulled, and an OpenAI key may not be entitled to the newest models.
 * A live list wins where one is available; otherwise the catalog answers, which
 * is also what happens with no key and when offline.
 */
import { createGateway } from "@ai-sdk/gateway";
import { getEndpointOverride } from "../config/user-config.ts";
import { KNOWN_BASE_URLS } from "./factories.ts";
import { listModelsFor, resolveProviderEntry } from "./resolve.ts";
import { logger } from "../utils/logger.ts";

const LIVE_TIMEOUT_MS = 3000;

/** Ids that come back from a /models endpoint but cannot drive a chat loop. */
const NON_CHAT = /embed|whisper|tts|dall-e|moderation|rerank|audio|realtime|image|video|guard/i;

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function fetchGoogle(apiKey: string): Promise<string[]> {
  const data = await getJson<{
    models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
  }>(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {});

  return (data?.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent") !== false)
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => n.includes("gemini") && !NON_CHAT.test(n) && !n.includes("bidi"));
}

async function fetchAnthropic(apiKey: string): Promise<string[]> {
  const data = await getJson<{ data?: Array<{ id: string }> }>("https://api.anthropic.com/v1/models", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  });
  return (data?.data ?? []).map((m) => m.id).filter((id) => id.includes("claude"));
}

async function fetchOpenAI(apiKey: string): Promise<string[]> {
  const data = await getJson<{ data?: Array<{ id: string }> }>("https://api.openai.com/v1/models", {
    Authorization: `Bearer ${apiKey}`,
  });
  return (data?.data ?? [])
    .map((m) => m.id)
    .filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !NON_CHAT.test(id))
    .sort();
}

async function fetchGateway(apiKey: string): Promise<string[]> {
  const { models } = await createGateway({ apiKey }).getAvailableModels();
  return models.filter((m) => m.modelType == null || m.modelType === "language").map((m) => m.id);
}

/** Works for anything speaking the OpenAI API, which is most of the catalog. */
async function fetchOpenAICompatible(baseURL: string, apiKey: string): Promise<string[]> {
  const data = await getJson<{ data?: Array<{ id: string }> }>(
    `${baseURL.replace(/\/+$/, "")}/models`,
    apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  );
  return (data?.data ?? []).map((m) => m.id).filter((id) => !NON_CHAT.test(id));
}

function fetchFor(
  id: string,
  npm: string | undefined,
  apiKey: string,
  baseURL: string | undefined,
): Promise<string[]> {
  switch (npm) {
    case "@ai-sdk/google":
      return fetchGoogle(apiKey);
    case "@ai-sdk/anthropic":
      return fetchAnthropic(apiKey);
    case "@ai-sdk/openai":
      return fetchOpenAI(apiKey);
    case "@ai-sdk/gateway":
      return fetchGateway(apiKey);
    default: {
      // Mistral, OpenRouter and every openai-compatible provider land here.
      const url = baseURL ?? KNOWN_BASE_URLS[id];
      return url ? fetchOpenAICompatible(url, apiKey) : Promise.resolve([]);
    }
  }
}

/**
 * Live model ids for a provider, falling back to the catalog. Never throws, and
 * never returns empty while the catalog knows something — the picker has to show
 * *something* even with a bad key or no network.
 */
export async function fetchLiveModels(provider: string, apiKey?: string): Promise<string[]> {
  const fromCatalog = listModelsFor(provider);
  const entry = resolveProviderEntry(provider);
  if (!entry || !apiKey) return fromCatalog;

  try {
    const live = await fetchFor(
      entry.id,
      entry.npm,
      apiKey,
      getEndpointOverride(entry.id) ?? entry.api,
    );
    if (live.length > 0) return [...new Set(live)];
  } catch (err) {
    logger.debug("model-fetcher: live query failed, using catalog", {
      provider: entry.id,
      error: String(err),
    });
  }

  return fromCatalog;
}

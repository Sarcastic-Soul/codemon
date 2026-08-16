/**
 * How to open a connection to a provider the catalog describes. Maps the
 * catalog's `npm` field to the factories we bundle, falling through to
 * `@ai-sdk/openai-compatible` at the catalog's `api` base URL for everyone else
 * — which is what makes the provider list data rather than code.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGateway } from "@ai-sdk/gateway";
import type { ProviderV4 } from "@ai-sdk/provider";
import type { CatalogProvider } from "./catalog.ts";

export interface FactoryOptions {
  apiKey: string;
  baseURL?: string;
}

type ProviderFactory = (options: FactoryOptions) => ProviderV4;

/**
 * Keyed on the catalog's `npm` field rather than a provider id, so every
 * upstream provider routes through the package we would have picked by hand.
 */
export const FACTORIES: Record<string, ProviderFactory> = {
  "@ai-sdk/google": (o) => createGoogleGenerativeAI(o) as ProviderV4,
  "@ai-sdk/anthropic": (o) => createAnthropic(o) as ProviderV4,
  "@ai-sdk/openai": (o) => createOpenAI(o) as ProviderV4,
  "@ai-sdk/mistral": (o) => createMistral(o) as ProviderV4,
  "@openrouter/ai-sdk-provider": (o) => createOpenRouter(o) as unknown as ProviderV4,
  "@ai-sdk/gateway": (o) => createGateway(o) as unknown as ProviderV4,
};

/** Packages whose model lists ship in the bundled snapshot. */
export const BUNDLED_PACKAGES: ReadonlySet<string> = new Set(Object.keys(FACTORIES));

/**
 * Base URLs for OpenAI-compatible providers the catalog lists with a dedicated
 * package but no `api` field. Anything missing here is still reachable via
 * `endpoints.<id>` in `~/.codemon/config.json`.
 */
export const KNOWN_BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  perplexity: "https://api.perplexity.ai",
};

export interface ResolvedFactory {
  provider: ProviderV4;
  /** How it was reached, for diagnostics. */
  via: "native" | "openai-compatible";
}

/**
 * Build an AI SDK provider for a catalog entry, or explain why we can't.
 * `baseURLOverride` comes from `endpoints.<id>` in the user config and wins.
 */
export function createProviderClient(
  entry: CatalogProvider,
  apiKey: string,
  baseURLOverride?: string,
): ResolvedFactory | { error: string } {
  const baseURL = baseURLOverride ?? entry.api ?? KNOWN_BASE_URLS[entry.id];

  const native = entry.npm ? FACTORIES[entry.npm] : undefined;
  if (native) {
    return { provider: native({ apiKey, baseURL }), via: "native" };
  }

  if (!baseURL) {
    return {
      error:
        `Provider "${entry.id}" needs the ${entry.npm ?? "provider-specific"} package, ` +
        `which Codemon does not bundle, and publishes no OpenAI-compatible base URL.\n` +
        `   Point it at one with  "endpoints": { "${entry.id}": "https://..." }  ` +
        `in ~/.codemon/config.json`,
    };
  }

  return {
    provider: createOpenAICompatible({
      name: entry.id,
      baseURL,
      apiKey,
    }) as unknown as ProviderV4,
    via: "openai-compatible",
  };
}

/** Whether this provider can be constructed at all — drives the picker's filter. */
export function isProviderSupported(entry: CatalogProvider, baseURLOverride?: string): boolean {
  if (entry.npm && FACTORIES[entry.npm]) return true;
  return Boolean(baseURLOverride ?? entry.api ?? KNOWN_BASE_URLS[entry.id]);
}

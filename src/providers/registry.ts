/**
 * Unified BYOK Provider Registry
 *
 * Uses Vercel AI SDK's `createProviderRegistry` so any model can be addressed
 * with the format  `provider:model-name`  (e.g. `google:gemini-2.0-flash-exp`).
 *
 * Each provider reads its API key from the standard environment variable:
 *   google    → GEMINI_API_KEY  or  GOOGLE_GENERATIVE_AI_API_KEY
 *   anthropic → ANTHROPIC_API_KEY
 *   openai    → OPENAI_API_KEY
 *   mistral   → MISTRAL_API_KEY
 *
 * To add more providers, install `@ai-sdk/<name>` and register below.
 */
import { createProviderRegistry, streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createMistral } from "@ai-sdk/mistral";
import type { Provider, ProviderConfig, StreamEvent, ModelMessage } from "./types.ts";
import type { ToolSet } from "ai";

// ---------------------------------------------------------------------------
// Build the registry — each provider lazily reads its key from env
// ---------------------------------------------------------------------------

export function buildProviderRegistry() {
  return createProviderRegistry({
    google: createGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
    }),
    anthropic: createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    }),
    openai: createOpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? "",
    }),
    mistral: createMistral({
      apiKey: process.env.MISTRAL_API_KEY ?? "",
    }),
  });
}

// ---------------------------------------------------------------------------
// Supported providers and their required env vars (for validation messages)
// ---------------------------------------------------------------------------

export const PROVIDER_ENV_VARS: Record<string, string[]> = {
  google: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
};

/**
 * Parse a model string like "google:gemini-2.0-flash-exp" into provider + model.
 * Also accepts legacy slash format "google/gemini-2.0-flash-exp" for compatibility.
 */
export function parseModelString(modelString: string): { provider: string; model: string } {
  // Normalize slash to colon
  const normalized = modelString.replace("/", ":");
  const colonIdx = normalized.indexOf(":");
  if (colonIdx === -1) {
    // No separator — assume google as default provider
    return { provider: "google", model: normalized };
  }
  return {
    provider: normalized.slice(0, colonIdx),
    model: normalized.slice(colonIdx + 1),
  };
}

/**
 * Validate that the required API key is present for a given provider.
 * Returns an error string if missing, or null if OK.
 */
export function validateApiKey(providerName: string): string | null {
  const envVars = PROVIDER_ENV_VARS[providerName];
  if (!envVars) return null; // Unknown provider — let it fail naturally
  const hasKey = envVars.some((v) => !!process.env[v]);
  if (!hasKey) {
    return (
      `❌ No API key found for provider "${providerName}".\n` +
      `   Set one of: ${envVars.map((v) => `$${v}`).join(", ")}`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Create a Provider instance using the registry
// ---------------------------------------------------------------------------

export function createRegistryProvider(config: ProviderConfig): Provider {
  const registry = buildProviderRegistry();
  const { provider: providerName, model: modelId } = parseModelString(config.model);

  // Canonical model string for the registry (always colon-separated)
  const registryModelId = `${providerName}:${modelId}`;

  return {
    async *streamMessage({ messages, tools, system, maxTokens }) {
      const model = registry.languageModel(
        registryModelId as `google:${string}` | `anthropic:${string}` | `openai:${string}` | `mistral:${string}`,
      );

      const result = streamText({
        model,
        messages: messages as ModelMessage[],
        tools: tools as ToolSet | undefined,
        system,
        maxOutputTokens: maxTokens ?? config.maxTokens ?? 8192,
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text", text: part.text } satisfies StreamEvent;
            break;

          case "tool-call": {
            const tc = part as unknown as {
              toolCallId: string;
              toolName: string;
              input: Record<string, unknown>;
            };
            yield {
              type: "tool-call",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              toolArgs: tc.input ?? {},
            } satisfies StreamEvent;
            break;
          }

          case "finish":
            yield {
              type: "finish",
              finishReason: part.finishReason,
              usage: part.totalUsage
                ? {
                    promptTokens: part.totalUsage.inputTokens ?? 0,
                    completionTokens: part.totalUsage.outputTokens ?? 0,
                  }
                : undefined,
            } satisfies StreamEvent;
            break;

          case "error":
            yield {
              type: "error",
              error: (part as { error: Error }).error,
            } satisfies StreamEvent;
            break;
        }
      }
    },
  };
}

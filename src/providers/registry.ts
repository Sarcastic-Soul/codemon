/**
 * Unified BYOK provider registry. Any model is addressed as `provider:model-name`,
 * with the providers, env vars and SDK packages all coming from `catalog.ts`
 * rather than a list here. Key precedence: `customKeys`, the catalog's env vars,
 * then `~/.codemon/config.json`.
 */
import { createProviderRegistry, streamText } from "ai";
import type { ProviderV4 } from "@ai-sdk/provider";
import type { Provider, ProviderConfig, StreamEvent, ModelMessage } from "./types.ts";
import type { ToolSet } from "ai";
import { getEffectiveApiKey, getEndpointOverride } from "../config/user-config.ts";
import { getProviderEnvVars, parseModelString } from "./catalog.ts";
import { createProviderClient } from "./factories.ts";
import { resolveProviderEntry } from "./resolve.ts";

// Defined in catalog.ts so the config layer can parse a model string without
// pulling in the AI SDK packages this module imports; re-exported because this
// is where callers have always imported it from.
export { parseModelString };

function resolveKey(providerName: string, customKeys?: Record<string, string>): string | undefined {
  return customKeys?.[providerName] ?? getEffectiveApiKey(providerName);
}

/** Returns an error string if the provider is unknown or keyless, else null. */
export function validateApiKey(
  providerName: string,
  customKeys?: Record<string, string>,
): string | null {
  const norm = providerName.toLowerCase();

  if (!resolveProviderEntry(norm)) {
    return (
      `❌ Unknown provider "${providerName}".\n` +
      `   Pick one with /connector, or declare it under "providers" in ~/.codemon/config.json`
    );
  }

  if (resolveKey(norm, customKeys)) return null;

  const envVars = getProviderEnvVars(norm);
  return (
    `❌ No API key found for provider "${norm}".\n` +
    `   Set one via /connector in TUI or export ${envVars.map((v) => `$${v}`).join(", ")}`
  );
}

/** Create a Provider instance backed by the registry. */
export function createRegistryProvider(
  config: ProviderConfig,
  customKeys?: Record<string, string>,
): Provider {
  const { provider: providerName, model: modelId } = parseModelString(config.model);

  const entry = resolveProviderEntry(providerName);
  if (!entry) {
    throw new Error(
      `Unknown provider "${providerName}". Pick one with /connector, or declare it under ` +
        `"providers" in ~/.codemon/config.json.`,
    );
  }

  const built = createProviderClient(
    entry,
    config.apiKey ?? resolveKey(providerName, customKeys) ?? "",
    getEndpointOverride(providerName),
  );
  if ("error" in built) throw new Error(built.error);

  const registry = createProviderRegistry<Record<string, ProviderV4>>({
    [providerName]: built.provider,
  });
  const registryModelId: `${string}:${string}` = `${providerName}:${modelId}`;

  return {
    async *streamMessage({ messages, tools, system, maxTokens }) {
      const model = registry.languageModel(registryModelId);

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

          // Models that think out loud emit this before any answer text. It is
          // shown dimmed rather than dropped: on a long tool-using turn it is
          // the only sign of what the model is actually doing.
          case "reasoning-delta":
            yield { type: "reasoning", text: part.text } satisfies StreamEvent;
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

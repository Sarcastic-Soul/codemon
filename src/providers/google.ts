import { streamText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Provider, ProviderConfig, StreamEvent, ModelMessage } from "./types.ts";
import type { ToolSet } from "ai";

export function createGoogleProvider(config: ProviderConfig): Provider {
  const google = createGoogleGenerativeAI({
    apiKey: config.apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
  });

  return {
    async *streamMessage({ messages, tools, system, maxTokens }) {
      const model = google(config.model ?? "gemini-2.0-flash-exp");

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
            // TypedToolCall: has toolName and input (not args)
            const tc = part as unknown as { toolCallId: string; toolName: string; input: Record<string, unknown> };
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
            yield { type: "error", error: (part as { error: Error }).error } satisfies StreamEvent;
            break;
        }
      }
    },
  };
}

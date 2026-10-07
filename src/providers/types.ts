/** Shared interface for all LLM backends, built on AI SDK v7's `ModelMessage`. */
import type { ModelMessage, ToolSet } from "ai";

export type { ModelMessage };

export interface ProviderConfig {
  model: string;
  maxTokens?: number;
  temperature?: number;
  apiKey?: string;
}

export interface StreamEvent {
  type: "text" | "reasoning" | "tool-call" | "tool-result" | "finish" | "error";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /**
   * Provider data attached to a tool call, such as Gemini's `thoughtSignature`.
   * It has to go back with the call when the history is replayed.
   */
  providerMetadata?: Record<string, Record<string, unknown>>;
  toolResult?: unknown;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
  error?: Error;
}

export interface Provider {
  streamMessage(params: {
    messages: ModelMessage[];
    tools?: ToolSet;
    system?: string;
    maxTokens?: number;
  }): AsyncIterable<StreamEvent>;
}

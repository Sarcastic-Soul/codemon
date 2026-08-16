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
  type: "text" | "tool-call" | "tool-result" | "finish" | "error";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
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

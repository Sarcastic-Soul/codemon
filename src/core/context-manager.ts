import { estimateMessagesTokens } from "../utils/tokenizer.ts";
import type { ModelMessage } from "../providers/types.ts";

export interface ContextStats {
  estimatedTokens: number;
  messageCount: number;
  percentUsed: number;
}

/**
 * Context manager — tracks token budget and truncates old messages
 * when approaching the limit. Summarization hook reserved for Stage 6.
 */
export class ContextManager {
  private maxTokens: number;

  constructor(maxContextTokens: number) {
    this.maxTokens = maxContextTokens;
  }

  getStats(messages: ModelMessage[], systemPrompt: string): ContextStats {
    const systemTokens = Math.ceil(systemPrompt.length / 4);
    const messageTokens = estimateMessagesTokens(
      messages.map((m) => ({
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    );
    const total = systemTokens + messageTokens;
    return {
      estimatedTokens: total,
      messageCount: messages.length,
      percentUsed: Math.round((total / this.maxTokens) * 100),
    };
  }

  /**
   * Truncates the oldest messages (preserving the last 20)
   * if we're approaching the token limit.
   */
  maybeTruncate(messages: ModelMessage[], systemPrompt: string): ModelMessage[] {
    const stats = this.getStats(messages, systemPrompt);
    if (stats.percentUsed < 80) return messages;

    // Keep the last 20 messages
    return messages.slice(-20);
  }
}

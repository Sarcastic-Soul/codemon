import { estimateTokens, estimateMessagesTokens } from "../utils/tokenizer.ts";
import type { ModelMessage } from "../providers/types.ts";

export interface ContextStats {
  estimatedTokens: number;
  messageCount: number;
  percentUsed: number;
}

/** Truncation engages once the history reaches this share of the budget. */
const TRUNCATE_AT_PERCENT = 80;
/** …and then drops whole turns until it fits in this share. */
const TARGET_PERCENT = 60;

/**
 * Context manager — tracks token budget and drops the oldest turns when
 * approaching the limit. Summarizing what it drops is the natural follow-on.
 */
export class ContextManager {
  private maxTokens: number;

  constructor(maxContextTokens: number) {
    this.maxTokens = maxContextTokens;
  }

  getStats(messages: ModelMessage[], systemPrompt: string): ContextStats {
    const total = estimateTokens(systemPrompt) + this.countTokens(messages);
    return {
      estimatedTokens: total,
      messageCount: messages.length,
      percentUsed: Math.round((total / this.maxTokens) * 100),
    };
  }

  /**
   * Drops the oldest complete turns when the history approaches the token
   * limit.
   *
   * Cutting at a flat message count can land the boundary between an assistant
   * message carrying `tool-call` parts and the `tool` message carrying their
   * results. Anthropic and OpenAI both reject that shape, so the failure mode
   * was: long sessions work until they cross the threshold, then every request
   * 400s with an error that points at the provider rather than at the trim.
   *
   * A turn starts at a user message and runs up to the next one, so everything
   * a request produced — assistant text, tool calls, tool results — moves as
   * one unit and neither half can be orphaned.
   */
  maybeTruncate(messages: ModelMessage[], systemPrompt: string): ModelMessage[] {
    const stats = this.getStats(messages, systemPrompt);
    if (stats.percentUsed < TRUNCATE_AT_PERCENT) return messages;

    const turnStarts: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === "user") turnStarts.push(i);
    }

    // No user message to cut at — an oversized history still round-trips,
    // a history sliced mid-turn does not.
    if (turnStarts.length === 0) return messages;

    const budget = Math.floor(this.maxTokens * (TARGET_PERCENT / 100)) - estimateTokens(systemPrompt);

    // The newest turn is kept whole even if it alone busts the budget: dropping
    // it would leave the model without the request it is answering.
    let keepFrom = turnStarts[turnStarts.length - 1]!;
    let kept = this.countTokens(messages.slice(keepFrom));

    for (let i = turnStarts.length - 2; i >= 0; i--) {
      const start = turnStarts[i]!;
      const turnTokens = this.countTokens(messages.slice(start, keepFrom));
      if (kept + turnTokens > budget) break;
      kept += turnTokens;
      keepFrom = start;
    }

    return messages.slice(keepFrom);
  }

  private countTokens(messages: ModelMessage[]): number {
    return estimateMessagesTokens(
      messages.map((m) => ({
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    );
  }
}

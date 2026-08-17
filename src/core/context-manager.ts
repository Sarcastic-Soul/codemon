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

/** Where the history would be cut, and whether it needs cutting at all. */
export interface TruncationPlan {
  /**
   * Index of the first message to keep. 0 means nothing is dropped, which is
   * also what a history with no cuttable turn boundary reports.
   */
  keepFrom: number;
  /** True when the history is over the threshold and `keepFrom` moved. */
  needsTruncation: boolean;
}

/** Tracks the token budget and drops the oldest turns as it fills. */
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
   * Where the oldest complete turns would be dropped as the history approaches
   * the token limit. Cutting on whole turns (user message up to the next one)
   * rather than a flat message count is what keeps a tool-call from being
   * orphaned from its result, a shape both Anthropic and OpenAI reject.
   *
   * Split out from `maybeTruncate` so the agent loop can summarise what is
   * about to be dropped before dropping it. `force` skips the threshold check,
   * which is what `/compact` does.
   */
  plan(messages: ModelMessage[], systemPrompt: string, force = false): TruncationPlan {
    const stats = this.getStats(messages, systemPrompt);
    if (!force && stats.percentUsed < TRUNCATE_AT_PERCENT) {
      return { keepFrom: 0, needsTruncation: false };
    }

    const turnStarts: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === "user") turnStarts.push(i);
    }

    // No user message to cut at — an oversized history still round-trips,
    // a history sliced mid-turn does not.
    if (turnStarts.length === 0) return { keepFrom: 0, needsTruncation: false };

    const budget = Math.floor(this.maxTokens * (TARGET_PERCENT / 100)) - estimateTokens(systemPrompt);

    // The newest turn is kept whole even if it alone busts the budget: dropping
    // it would leave the model without the request it is answering.
    let keepFrom = turnStarts[turnStarts.length - 1]!;
    let kept = this.countTokens(messages.slice(keepFrom));

    // Forced means "compact now" — everything but the current turn goes, and
    // the grow-back below is skipped. Without this a `/compact` on a history
    // that comfortably fits would grow the boundary straight back to 0 and
    // report that there was nothing to do.
    if (force) return { keepFrom, needsTruncation: keepFrom > 0 };

    for (let i = turnStarts.length - 2; i >= 0; i--) {
      const start = turnStarts[i]!;
      const turnTokens = this.countTokens(messages.slice(start, keepFrom));
      if (kept + turnTokens > budget) break;
      kept += turnTokens;
      keepFrom = start;
    }

    return { keepFrom, needsTruncation: keepFrom > 0 };
  }

  /**
   * Drops the oldest complete turns as the history approaches the token limit.
   * The lossy path: kept as the fallback for when summarising is unavailable
   * or fails, since an over-long history is a hard error and a forgotten one
   * is merely a bad one.
   */
  maybeTruncate(messages: ModelMessage[], systemPrompt: string): ModelMessage[] {
    const { keepFrom } = this.plan(messages, systemPrompt);
    return keepFrom > 0 ? messages.slice(keepFrom) : messages;
  }

  private countTokens(messages: ModelMessage[]): number {
    return estimateMessagesTokens(
      messages.map((m) => ({
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    );
  }
}

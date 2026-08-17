/**
 * Summarising compaction: the oldest turns are summarised rather than dropped,
 * so a long session shrinks without the agent forgetting what it was doing.
 *
 * Two invariants:
 *   - The message store is never rewritten. Only the slice sent to the provider
 *     changes; --rewind and --audit still see the real transcript.
 *   - A failed summariser never fails the turn — every path falls back to plain
 *     truncation rather than throwing.
 */
import type { ModelMessage, Provider } from "../providers/types.ts";
import type { CodemonConfig } from "../config/defaults.ts";
import type { ContextManager } from "./context-manager.ts";
import type { CompactionRecord, MessageStore } from "./message-store.ts";
import { estimateTokens } from "../utils/tokenizer.ts";
import { logger } from "../utils/logger.ts";

/** Prefix on the synthetic message, and the marker tests and the TUI look for. */
export const SUMMARY_PREFIX = "[Summary of earlier conversation]";

/**
 * Ceiling on the summary itself. Generous enough to keep file paths and
 * decisions, small enough that summarising is always a net win.
 */
const SUMMARY_MAX_TOKENS = 1500;

const SUMMARY_SYSTEM_PROMPT = `You are compacting the earlier part of a coding session so the agent can keep working without the full transcript.

Write a dense factual summary covering, in this order:
1. What the user originally asked for, and any later changes to that goal.
2. Decisions made and the reasoning behind them.
3. Files read, created or modified — with exact paths.
4. Commands run and what they returned (test results, errors, exit codes).
5. What is still outstanding: the next step, and anything known to be broken.

Rules:
- Preserve file paths, function names, identifiers and error strings verbatim. They are the load-bearing part.
- Write in plain declarative sentences. No preamble, no sign-off, no "the user asked me to".
- Do not speculate about what happens next beyond what was explicitly stated.
- If a prior summary is included, fold it in rather than describing it.`;

/** Flatten a stored message into something the summariser can read. */
function renderMessage(msg: ModelMessage): string {
  const body =
    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  return `### ${msg.role}\n${body}`;
}

/**
 * Ask the model to summarise `messages`, folding in `previous` if given.
 * Returns null on any failure — the caller falls back to plain truncation.
 */
export async function compactHistory(
  messages: ModelMessage[],
  provider: Provider,
  config: CodemonConfig,
  options: { previous?: string; instruction?: string } = {},
): Promise<string | null> {
  if (messages.length === 0 && !options.previous) return null;

  const parts: string[] = [];
  if (options.previous) {
    parts.push(`## Summary of the session so far\n\n${options.previous}`);
  }
  if (messages.length > 0) {
    parts.push(`## Transcript to fold in\n\n${messages.map(renderMessage).join("\n\n")}`);
  }
  if (options.instruction) {
    parts.push(`## Extra instruction from the user\n\n${options.instruction}`);
  }

  try {
    let summary = "";
    // No tools: the summariser reads a transcript, it does not act on the repo.
    for await (const event of provider.streamMessage({
      messages: [{ role: "user", content: parts.join("\n\n") }],
      system: SUMMARY_SYSTEM_PROMPT,
      maxTokens: Math.min(SUMMARY_MAX_TOKENS, config.maxTokens),
    })) {
      if (event.type === "text") summary += event.text ?? "";
      if (event.type === "error") throw event.error ?? new Error("summariser stream error");
    }

    const trimmed = summary.trim();
    return trimmed === "" ? null : trimmed;
  } catch (err) {
    logger.warn("compaction: summariser failed, falling back to truncation", {
      error: String(err),
    });
    return null;
  }
}

export interface CompactionOutcome {
  /** True when a new summary was produced and stored. */
  compacted: boolean;
  /** How many messages the sent slice no longer carries. */
  droppedMessages: number;
  /** Rough size of the summary that replaced them. */
  summaryTokens: number;
  /** Why nothing happened, when `compacted` is false. */
  reason?: string;
}

/**
 * Compact if the history warrants it (or if `force`), storing the result on the
 * store. Returns what happened; the caller decides what to say about it.
 *
 * The slice handed to the summariser is exactly what plain truncation would
 * have thrown away, minus anything an earlier summary already covers.
 */
export async function maybeCompact(
  store: MessageStore,
  contextManager: ContextManager,
  systemPrompt: string,
  provider: Provider,
  config: CodemonConfig,
  options: { force?: boolean; instruction?: string } = {},
): Promise<CompactionOutcome> {
  const messages = store.getMessages();
  const { keepFrom, needsTruncation } = contextManager.plan(
    messages,
    systemPrompt,
    options.force ?? false,
  );

  if (!needsTruncation) {
    return { compacted: false, droppedMessages: 0, summaryTokens: 0, reason: "nothing to compact" };
  }

  const previous = store.getCompaction();
  // Everything an earlier summary already covers is skipped; summaries compose
  // rather than re-summarising the same turns each time the window fills.
  const from = previous ? previous.throughSeq + 1 : 0;
  if (from >= keepFrom) {
    return {
      compacted: false,
      droppedMessages: 0,
      summaryTokens: 0,
      reason: "already summarised through this point",
    };
  }

  const slice = messages.slice(from, keepFrom);
  const summary = await compactHistory(slice, provider, config, {
    previous: previous?.summary,
    instruction: options.instruction,
  });

  if (summary === null) {
    return { compacted: false, droppedMessages: 0, summaryTokens: 0, reason: "summariser failed" };
  }

  store.saveCompaction({ summary, throughSeq: keepFrom - 1 });

  return {
    compacted: true,
    droppedMessages: keepFrom,
    summaryTokens: estimateTokens(summary),
  };
}

/**
 * Build the slice actually sent to the provider.
 *
 * The cut is the further back of what the context manager planned and what a
 * stored summary already covers — otherwise `/compact` would be pointless, since
 * the manager plans no cut on the next turn and resending the summarised turns
 * hands the freed context straight back.
 *
 * The summary rides as a `user` message: the system slot is taken by the real
 * prompt, and several providers accept only one.
 */
export function applyCompaction(
  messages: ModelMessage[],
  keepFrom: number,
  record: CompactionRecord | null,
): ModelMessage[] {
  const cut = Math.max(keepFrom, record ? record.throughSeq + 1 : 0);
  if (cut <= 0) return messages;

  const kept = messages.slice(cut);
  if (!record) return kept;

  return [
    { role: "user", content: `${SUMMARY_PREFIX}\n\n${record.summary}` },
    ...kept,
  ];
}

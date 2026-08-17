/**
 * The history abstraction the agent loop runs against.
 *
 * Lives in its own module rather than in agent-loop.ts because compaction needs
 * the type and the loop needs compaction — importing across that pair directly
 * is a cycle.
 */
import type { ModelMessage } from "../providers/types.ts";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * A summary standing in for `messages[0 .. throughSeq]`, which are no longer
 * sent to the provider. The messages themselves are never deleted.
 */
export interface CompactionRecord {
  summary: string;
  /** Index of the last message the summary covers. */
  throughSeq: number;
}

/**
 * MessageStore — abstraction over message history.
 * The main agent uses the global session store; sub-agents use ephemeral stores.
 */
export interface MessageStore {
  getMessages(): ModelMessage[];
  addMessage(msg: ModelMessage): void;
  updateTokenUsage(usage: TokenUsage): void;
  /** The summary covering everything already compacted away, if any. */
  getCompaction(): CompactionRecord | null;
  saveCompaction(record: CompactionRecord): void;
}

/** Create a fresh in-memory store (for sub-agents and evals) */
export function createInMemoryStore(initialMessages: ModelMessage[] = []): MessageStore {
  const messages: ModelMessage[] = [...initialMessages];
  let compaction: CompactionRecord | null = null;
  return {
    getMessages: () => messages,
    addMessage: (msg) => messages.push(msg),
    updateTokenUsage: (_) => {},
    getCompaction: () => compaction,
    saveCompaction: (record) => { compaction = record; },
  };
}

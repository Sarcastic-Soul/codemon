import { getDb } from "./db.ts";
import type { CompactionRecord } from "../core/message-store.ts";

/**
 * Record a summary of `messages[0 .. throughSeq]`. Inserted rather than
 * updated: the history of what was summarised when is itself worth keeping,
 * and reads always take the furthest-reaching row.
 */
export function dbSaveCompaction(sessionId: string, record: CompactionRecord): void {
  getDb()
    .query(
      `INSERT INTO compactions (session_id, through_seq, summary, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, record.throughSeq, record.summary, new Date().toISOString());
}

/**
 * The summary covering the most history. Ordered by `through_seq` rather than
 * by time so a `/compact` that reached further back still wins over a later
 * automatic one that did not.
 */
export function dbGetLatestCompaction(sessionId: string): CompactionRecord | null {
  const row = getDb()
    .query(
      `SELECT through_seq, summary
         FROM compactions
        WHERE session_id = ?
        ORDER BY through_seq DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionId) as { through_seq: number; summary: string } | null;

  return row ? { summary: row.summary, throughSeq: row.through_seq } : null;
}

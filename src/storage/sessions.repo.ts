import { getDb } from "./db.ts";
import type { ModelMessage } from "../providers/types.ts";

export interface StoredSession {
  id: string;
  region: string;
  model: string;
  startedAt: string;
  lastActive: string;
  /** prompt + completion — what the session cost */
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  messageCount: number;
}

/** Cumulative usage for a session, as stored. */
export interface SessionTokens {
  promptTokens: number;
  completionTokens: number;
}

interface SessionRow {
  id: string;
  region: string;
  model: string;
  started_at: string;
  last_active: string;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  message_count: number;
}

/**
 * Message count comes from a join rather than the row, so the picker can show
 * it — and so a session that never got a message can be left out of the
 * listings. Sessions are created lazily now, but databases from before that
 * still hold a row per launch.
 */
const SESSION_SELECT = `
  SELECT s.id, s.region, s.model, s.started_at, s.last_active,
         s.total_tokens, s.prompt_tokens, s.completion_tokens,
         COUNT(m.id) AS message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id`;

function toStoredSession(r: SessionRow): StoredSession {
  return {
    id: r.id,
    region: r.region,
    model: r.model,
    startedAt: r.started_at,
    lastActive: r.last_active,
    totalTokens: r.total_tokens,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    messageCount: r.message_count,
  };
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * `OR IGNORE`, not `OR REPLACE`. The row is written lazily now, so this runs
 * once a session already has content — and REPLACE deletes the conflicting row
 * before inserting, which with `ON DELETE CASCADE` would take the session's
 * messages and checkpoints with it and reset its token total. Ids are UUIDs, so
 * a conflict means the session is already stored and should be left alone.
 */
export function dbCreateSession(id: string, region: string, model: string): void {
  const now = new Date().toISOString();
  getDb()
    .query(
      `INSERT OR IGNORE INTO sessions (id, region, model, started_at, last_active)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, region, model, now, now);
}

export function dbTouchSession(id: string, tokens: SessionTokens): void {
  getDb()
    .query(
      `UPDATE sessions
          SET last_active = ?, prompt_tokens = ?, completion_tokens = ?, total_tokens = ?
        WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      tokens.promptTokens,
      tokens.completionTokens,
      tokens.promptTokens + tokens.completionTokens,
      id,
    );
}

export function dbUpdateSessionModel(id: string, model: string): void {
  getDb()
    .query(`UPDATE sessions SET model = ?, last_active = ? WHERE id = ?`)
    .run(model, new Date().toISOString(), id);
}

/** One session by id, whether or not it has messages. */
export function dbGetSession(id: string): StoredSession | null {
  const row = getDb()
    .query(`${SESSION_SELECT} WHERE s.id = ? GROUP BY s.id`)
    .get(id) as SessionRow | null;
  return row ? toStoredSession(row) : null;
}

export function dbGetLastSessionForRegion(region: string): StoredSession | null {
  const row = getDb()
    .query(
      `${SESSION_SELECT}
        WHERE s.region = ?
        GROUP BY s.id
       HAVING message_count > 0
        ORDER BY s.last_active DESC
        LIMIT 1`,
    )
    .get(region) as SessionRow | null;
  return row ? toStoredSession(row) : null;
}

export function dbListSessions(region: string, limit = 10): StoredSession[] {
  const rows = getDb()
    .query(
      `${SESSION_SELECT}
        WHERE s.region = ?
        GROUP BY s.id
       HAVING message_count > 0
        ORDER BY s.last_active DESC
        LIMIT ?`,
    )
    .all(region, limit) as SessionRow[];

  return rows.map(toStoredSession);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function dbInsertMessage(sessionId: string, seq: number, msg: ModelMessage): void {
  getDb()
    .query(
      `INSERT INTO messages (session_id, seq, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, seq, msg.role, JSON.stringify(msg.content), new Date().toISOString());
}

export function dbLoadMessages(sessionId: string): ModelMessage[] {
  const rows = getDb()
    .query(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY seq ASC`)
    .all(sessionId) as Array<{ role: string; content: string }>;

  return rows.map((r) => ({
    role: r.role as ModelMessage["role"],
    content: (() => {
      try { return JSON.parse(r.content); } catch { return r.content; }
    })(),
  })) as ModelMessage[];
}

export function dbDeleteMessages(sessionId: string): void {
  getDb().query(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
}

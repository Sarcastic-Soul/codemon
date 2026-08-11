import { getDb } from "./db.ts";
import type { ModelMessage } from "../providers/types.ts";

export interface StoredSession {
  id: string;
  region: string;
  model: string;
  startedAt: string;
  lastActive: string;
  totalTokens: number;
  messages: ModelMessage[];
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export function dbCreateSession(id: string, region: string, model: string): void {
  const now = new Date().toISOString();
  getDb()
    .query(
      `INSERT OR REPLACE INTO sessions (id, region, model, started_at, last_active)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, region, model, now, now);
}

export function dbTouchSession(id: string, totalTokens: number): void {
  getDb()
    .query(`UPDATE sessions SET last_active = ?, total_tokens = ? WHERE id = ?`)
    .run(new Date().toISOString(), totalTokens, id);
}

export function dbGetLastSessionForRegion(region: string): { id: string; model: string } | null {
  const row = getDb()
    .query(`SELECT id, model FROM sessions WHERE region = ? ORDER BY last_active DESC LIMIT 1`)
    .get(region) as { id: string; model: string } | null;
  return row;
}

export function dbListSessions(region: string, limit = 10): StoredSession[] {
  const rows = getDb()
    .query(
      `SELECT id, region, model, started_at, last_active, total_tokens
       FROM sessions WHERE region = ? ORDER BY last_active DESC LIMIT ?`,
    )
    .all(region, limit) as Array<{
    id: string; region: string; model: string;
    started_at: string; last_active: string; total_tokens: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    region: r.region,
    model: r.model,
    startedAt: r.started_at,
    lastActive: r.last_active,
    totalTokens: r.total_tokens,
    messages: [],
  }));
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

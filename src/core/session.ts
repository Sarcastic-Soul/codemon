import type { ModelMessage } from "../providers/types.ts";
import {
  dbCreateSession,
  dbTouchSession,
  dbInsertMessage,
  dbLoadMessages,
  dbGetLastSessionForRegion,
} from "../pokedex/sessions.repo.ts";

export interface Session {
  id: string;
  startedAt: string;
  messages: ModelMessage[];
  totalTokensUsed: number;
  region: string;
  model: string;
}

let currentSession: Session | null = null;

export function createSession(region: string, model = ""): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    messages: [],
    totalTokensUsed: 0,
    region,
    model,
  };
  currentSession = session;

  // Persist to SQLite (no-op if DB not initialized — getDb() uses :memory: fallback)
  try {
    dbCreateSession(session.id, region, model);
  } catch {}

  return session;
}

/**
 * Resume the most recent session for this region.
 * Loads its messages from SQLite back into memory.
 * Returns null if no prior session found.
 */
export function resumeLastSession(region: string): Session | null {
  try {
    const row = dbGetLastSessionForRegion(region);
    if (!row) return null;

    const messages = dbLoadMessages(row.id);
    const session: Session = {
      id: row.id,
      startedAt: new Date().toISOString(),
      messages,
      totalTokensUsed: 0,
      region,
      model: row.model,
    };
    currentSession = session;
    return session;
  } catch {
    return null;
  }
}

export function getSession(): Session {
  if (!currentSession) throw new Error("No active session. Call createSession first.");
  return currentSession;
}

export function addMessage(message: ModelMessage): void {
  const session = getSession();
  session.messages.push(message);

  // Persist to SQLite
  try {
    const seq = session.messages.length - 1;
    dbInsertMessage(session.id, seq, message);
    dbTouchSession(session.id, session.totalTokensUsed);
  } catch {}
}

export function updateTokenUsage(tokens: number): void {
  const session = getSession();
  session.totalTokensUsed += tokens;
  try {
    dbTouchSession(session.id, session.totalTokensUsed);
  } catch {}
}

export function getMessages(): ModelMessage[] {
  return getSession().messages;
}

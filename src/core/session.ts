import type { ModelMessage } from "../providers/types.ts";
import {
  dbCreateSession,
  dbTouchSession,
  dbUpdateSessionModel,
  dbInsertMessage,
  dbLoadMessages,
  dbGetSession,
  dbGetLastSessionForRegion,
} from "../storage/sessions.repo.ts";
import type { SessionTokens, StoredSession } from "../storage/sessions.repo.ts";
import { dbGetLatestCompaction, dbSaveCompaction } from "../storage/compactions.repo.ts";
import type { CompactionRecord } from "./message-store.ts";

export interface Session {
  id: string;
  startedAt: string;
  messages: ModelMessage[];
  /** Summary covering the history no longer sent to the provider, if any. */
  compaction: CompactionRecord | null;
  /** Tracked apart: an agentic loop resends the whole history every turn, so
   *  prompt tokens dominate spend. */
  promptTokensUsed: number;
  completionTokensUsed: number;
  /** promptTokensUsed + completionTokensUsed */
  totalTokensUsed: number;
  region: string;
  model: string;
}

const NO_TOKENS = { promptTokensUsed: 0, completionTokensUsed: 0, totalTokensUsed: 0 };

/**
 * Usage as stored, ready to seed a resumed session with. Older rows counted
 * `total_tokens` as completion only, so the unattributed remainder goes there.
 */
function seedTokens(row: StoredSession) {
  const unattributed = Math.max(0, row.totalTokens - row.promptTokens - row.completionTokens);
  const completionTokensUsed = row.completionTokens + unattributed;
  return {
    promptTokensUsed: row.promptTokens,
    completionTokensUsed,
    totalTokensUsed: row.promptTokens + completionTokensUsed,
  };
}

let currentSession: Session | null = null;

/**
 * Whether the current session has a row yet. Sessions are written lazily, once
 * they have content, so the picker stays scannable.
 */
let persisted = false;

export function createSession(region: string, model = ""): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    messages: [],
    compaction: null,
    ...NO_TOKENS,
    region,
    model,
  };
  currentSession = session;
  persisted = false;

  return session;
}

/**
 * Write the session row if it isn't there yet. Called before anything that
 * references the session id — messages and checkpoints carry a foreign key to it.
 */
export function ensureSessionPersisted(): void {
  const session = getSession();
  if (persisted) return;
  // The model can have changed via /connector since the session was created, so
  // the row is written with whatever is current rather than what it started as.
  dbCreateSession(session.id, session.region, session.model);
  persisted = true;
}

/**
 * Resume the most recent session for this region, loading its messages back
 * from SQLite. Returns null if no prior session found.
 */
export function resumeLastSession(region: string): Session | null {
  try {
    const row = dbGetLastSessionForRegion(region);
    if (!row) return null;
    return adopt(row, region, row.model);
  } catch {
    return null;
  }
}

/** Resume a specific past session by its ID. Used by the SessionPicker. */
export function resumeSpecificSession(sessionId: string, region: string, model: string): Session {
  const row = dbGetSession(sessionId);
  if (!row) throw new Error(`No stored session with id "${sessionId}".`);
  return adopt(row, region, model);
}

/**
 * Make a stored session the current one, carrying its usage back in — starting
 * the counters at zero would push those zeros over the real total.
 */
function adopt(row: StoredSession, region: string, model: string): Session {
  const session: Session = {
    id: row.id,
    startedAt: new Date().toISOString(),
    messages: dbLoadMessages(row.id),
    // Loaded back so a resumed session does not re-summarise turns it already
    // paid to summarise once.
    compaction: (() => {
      try { return dbGetLatestCompaction(row.id); } catch { return null; }
    })(),
    ...seedTokens(row),
    region,
    model,
  };
  currentSession = session;
  persisted = true;
  return session;
}


export function getSession(): Session {
  if (!currentSession) throw new Error("No active session. Call createSession first.");
  return currentSession;
}

/**
 * Drop the in-memory session. Anything already written stays in the database —
 * this ends the session, it does not delete it.
 */
export function endSession(): void {
  currentSession = null;
  persisted = false;
}

export function addMessage(message: ModelMessage): void {
  const session = getSession();
  session.messages.push(message);

  // Persist to SQLite
  try {
    ensureSessionPersisted();
    const seq = session.messages.length - 1;
    dbInsertMessage(session.id, seq, message);
    dbTouchSession(session.id, sessionTokens(session));
  } catch {}
}

export function updateTokenUsage(usage: SessionTokens): void {
  const session = getSession();
  session.promptTokensUsed += usage.promptTokens;
  session.completionTokensUsed += usage.completionTokens;
  session.totalTokensUsed = session.promptTokensUsed + session.completionTokensUsed;
  try {
    ensureSessionPersisted();
    dbTouchSession(session.id, sessionTokens(session));
  } catch {}
}

function sessionTokens(session: Session): SessionTokens {
  return {
    promptTokens: session.promptTokensUsed,
    completionTokens: session.completionTokensUsed,
  };
}

export function updateSessionModel(model: string): void {
  try {
    const session = getSession();
    session.model = model;
    // Deliberately does not create the row: switching model before typing
    // anything is still an empty session.
    if (persisted) dbUpdateSessionModel(session.id, model);
  } catch {}
}

export function getMessages(): ModelMessage[] {
  return getSession().messages;
}

export function getCompaction(): CompactionRecord | null {
  try { return getSession().compaction; } catch { return null; }
}

/**
 * Store a summary of the history up to `throughSeq`. Held in memory even if the
 * write fails, so a read-only database costs the session persistence but not
 * the summary it just paid a model call for.
 */
export function saveCompaction(record: CompactionRecord): void {
  const session = getSession();
  session.compaction = record;
  try {
    ensureSessionPersisted();
    dbSaveCompaction(session.id, record);
  } catch {}
}

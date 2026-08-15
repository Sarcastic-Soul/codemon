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

export interface Session {
  id: string;
  startedAt: string;
  messages: ModelMessage[];
  /** Prompt and completion tokens are tracked apart: an agentic loop resends
   *  the whole history every turn, so prompt tokens dominate spend while
   *  completion tokens measure what the model actually wrote. */
  promptTokensUsed: number;
  completionTokensUsed: number;
  /** promptTokensUsed + completionTokensUsed */
  totalTokensUsed: number;
  region: string;
  model: string;
}

const NO_TOKENS = { promptTokensUsed: 0, completionTokensUsed: 0, totalTokensUsed: 0 };

/**
 * Usage as stored, ready to seed a resumed session with.
 *
 * `total_tokens` used to mean completion tokens only, before the two halves were
 * recorded separately. A row from then has a total its two columns don't
 * account for, and that remainder is completion by definition — attributing it
 * keeps `total = prompt + completion` true without inventing a split.
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
 * Whether the current session has a row yet. A session is only written once it
 * has something in it — launching Codemon and quitting used to leave a row
 * behind, and the picker is only worth having while it stays scannable.
 */
let persisted = false;

export function createSession(region: string, model = ""): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    messages: [],
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
 * references the session id — messages and checkpoints both carry a foreign key
 * to it, and the row now arrives later than it used to.
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
 * Resume the most recent session for this region.
 * Loads its messages from SQLite back into memory.
 * Returns null if no prior session found.
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

/**
 * Resume any specific past session by its ID.
 * Used by the interactive SessionPicker.
 */
export function resumeSpecificSession(sessionId: string, region: string, model: string): Session {
  const row = dbGetSession(sessionId);
  if (!row) throw new Error(`No stored session with id "${sessionId}".`);
  return adopt(row, region, model);
}

/**
 * Make a stored session the current one, carrying its usage back in.
 *
 * Resuming used to start the counters at zero, and the next write pushed those
 * zeros over the real total — so a resumed session permanently read as having
 * cost nothing.
 */
function adopt(row: StoredSession, region: string, model: string): Session {
  const session: Session = {
    id: row.id,
    startedAt: new Date().toISOString(),
    messages: dbLoadMessages(row.id),
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
 * Drop the in-memory session, returning the module to its pre-`createSession`
 * state. Anything already written stays in the database — this ends the
 * session, it does not delete it.
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
    // anything is still an empty session. `ensureSessionPersisted` writes
    // whatever model is current when the first message arrives.
    if (persisted) dbUpdateSessionModel(session.id, model);
  } catch {}
}

export function getMessages(): ModelMessage[] {
  return getSession().messages;
}

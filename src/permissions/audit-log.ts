/**
 * Audit trail for every decision the permission gate makes. Decisions go
 * straight to SQLite — no in-memory copy — and come back out via `--audit`.
 */
import { dbInsertDecision, type AuditDecision } from "../storage/audit.repo.ts";
import { getSession } from "../core/session.ts";
import { logger } from "../utils/logger.ts";

export interface AuditEntry {
  toolName: string;
  permissionLevel: string;
  args: Record<string, unknown>;
  decision: AuditDecision;
}

export function recordDecision(entry: AuditEntry): void {
  let sessionId = "";
  try {
    sessionId = getSession().id;
  } catch {
    // Evals and sub-agents run without a session row; the decision is still
    // worth recording, just unattributed.
  }

  try {
    dbInsertDecision({ ...entry, sessionId, timestamp: new Date().toISOString() });
  } catch (err) {
    // An audit failure must never block the tool call it is describing.
    logger.warn("audit-log: could not persist decision", { error: String(err) });
  }
}

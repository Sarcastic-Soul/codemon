/**
 * In-memory audit log for every permission decision made during a session.
 * Will be persisted to Pokédex (SQLite) in Stage 5.
 */

export interface AuditEntry {
  timestamp: string;
  toolName: string;
  permissionLevel: string;
  args: Record<string, unknown>;
  decision: "allow" | "deny" | "ask-allow" | "ask-deny" | "always-allow";
}

const entries: AuditEntry[] = [];

export function recordDecision(entry: Omit<AuditEntry, "timestamp">) {
  entries.push({ ...entry, timestamp: new Date().toISOString() });
}

export function getAuditLog(): readonly AuditEntry[] {
  return entries;
}

export function clearAuditLog() {
  entries.length = 0;
}

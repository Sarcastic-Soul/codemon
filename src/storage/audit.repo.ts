import { getDb } from "./db.ts";

export type AuditDecision = "allow" | "deny" | "ask-allow" | "ask-deny" | "always-allow";

export interface StoredDecision {
  sessionId: string;
  toolName: string;
  permissionLevel: string;
  decision: AuditDecision;
  args: string;
  createdAt: string;
}

/**
 * Tool arguments can be enormous — `write_file` carries an entire file body.
 * The audit trail wants enough to identify the call, not a second copy of the
 * repository.
 */
const MAX_ARGS_CHARS = 2000;

function serializeArgs(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? "{}";
  } catch {
    return '{"error":"arguments could not be serialized"}';
  }
  return json.length > MAX_ARGS_CHARS ? `${json.slice(0, MAX_ARGS_CHARS)}…[truncated]` : json;
}

export function dbInsertDecision(entry: {
  sessionId: string;
  toolName: string;
  permissionLevel: string;
  decision: AuditDecision;
  args: Record<string, unknown>;
  timestamp: string;
}): void {
  getDb()
    .query(
      `INSERT INTO permission_decisions
         (session_id, tool_name, permission_level, decision, args, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.sessionId,
      entry.toolName,
      entry.permissionLevel,
      entry.decision,
      serializeArgs(entry.args),
      entry.timestamp,
    );
}

export function dbListDecisions(sessionId: string, limit = 200): StoredDecision[] {
  const rows = getDb()
    .query(
      `SELECT session_id, tool_name, permission_level, decision, args, created_at
       FROM permission_decisions
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(sessionId, limit) as Array<{
    session_id: string;
    tool_name: string;
    permission_level: string;
    decision: string;
    args: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    toolName: r.tool_name,
    permissionLevel: r.permission_level,
    decision: r.decision as AuditDecision,
    args: r.args,
    createdAt: r.created_at,
  }));
}

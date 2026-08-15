import * as fs from "fs";
import { getDb } from "./db.ts";

export interface StoredCheckpoint {
  id: number;
  sessionId: string;
  filePath: string;
  originalContent: string;
  toolName: string;
  createdAt: string;
}

/**
 * Save the original content of a file before it is modified.
 * Only saves the FIRST checkpoint per file per session (preserves "original" state).
 */
export function dbSaveCheckpoint(
  sessionId: string,
  filePath: string,
  originalContent: string,
  toolName: string,
): void {
  // Don't overwrite — only keep the first (original) checkpoint per file per session
  const existing = getDb()
    .query(`SELECT id FROM checkpoints WHERE session_id = ? AND file_path = ? LIMIT 1`)
    .get(sessionId, filePath);
  if (existing) return;

  getDb()
    .query(
      `INSERT INTO checkpoints (session_id, file_path, original_content, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, filePath, originalContent, toolName, new Date().toISOString());
}

export function dbGetCheckpoints(sessionId: string): StoredCheckpoint[] {
  // SQLite hands back the column names as written — `file_path`, not `filePath`.
  // Casting the rows straight to StoredCheckpoint made every field on this
  // interface `undefined`, which is how `--rewind` came to restore nothing:
  // `writeFileSync(undefined, undefined)` throws, and each file was reported as
  // a failure with no name.
  const rows = getDb()
    .query(
      `SELECT id, session_id, file_path, original_content, tool_name, created_at
       FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId) as Array<{
    id: number;
    session_id: string;
    file_path: string;
    original_content: string;
    tool_name: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    filePath: r.file_path,
    originalContent: r.original_content,
    toolName: r.tool_name,
    createdAt: r.created_at,
  }));
}

/**
 * Restore all files from checkpoints of the given session.
 * Returns a list of { filePath, success, error } for each file restored.
 */
export function dbRestoreCheckpoints(
  sessionId: string,
): Array<{ filePath: string; success: boolean; error?: string }> {
  const checkpoints = dbGetCheckpoints(sessionId);
  const results: Array<{ filePath: string; success: boolean; error?: string }> = [];

  for (const cp of checkpoints) {
    try {
      fs.writeFileSync(cp.filePath, cp.originalContent, "utf8");
      results.push({ filePath: cp.filePath, success: true });
    } catch (err) {
      results.push({
        filePath: cp.filePath,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function dbCountCheckpoints(sessionId: string): number {
  const row = getDb()
    .query(`SELECT COUNT(*) as n FROM checkpoints WHERE session_id = ?`)
    .get(sessionId) as { n: number };
  return row.n;
}

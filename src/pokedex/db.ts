/**
 * Pokédex — SQLite persistence layer.
 * Uses Bun's built-in bun:sqlite (zero config, zero deps).
 * DB path: <project-root>/.codemon/pokedex.db (gitignored)
 */
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

let _db: Database | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  region      TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL,
  last_active TEXT NOT NULL,
  total_tokens INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path        TEXT NOT NULL,
  original_content TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_region    ON sessions(region, last_active DESC);
`;

export function initDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(dbPath);
  _db.exec(SCHEMA);
}

export function getDb(): Database {
  if (!_db) {
    // Return a no-op in-memory db if initDb was never called (e.g. tests without persistence)
    _db = new Database(":memory:");
    _db.exec(SCHEMA);
  }
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

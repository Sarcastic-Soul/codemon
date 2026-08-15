/**
 * Pokédex — SQLite persistence layer.
 * Uses Bun's built-in bun:sqlite (zero config, zero deps).
 * DB path: <project-root>/.codemon/sessions.db (gitignored)
 */
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

let _db: Database | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- total_tokens is prompt + completion: what the session cost. The two halves
-- are kept separately because they answer different questions — prompt tokens
-- track how much history is being resent, completion tokens how much the model
-- actually produced.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  region      TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL,
  last_active TEXT NOT NULL,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0
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

-- Every decision the permission gate makes. Deliberately has no foreign key to
-- sessions: decisions are recorded on every tool call, including from evals and
-- sub-agents that run without a session row, and a constraint violation here
-- would take down the gate rather than lose a log line.
CREATE TABLE IF NOT EXISTS permission_decisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL DEFAULT '',
  tool_name        TEXT NOT NULL,
  permission_level TEXT NOT NULL,
  decision         TEXT NOT NULL,
  args             TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_decisions_session  ON permission_decisions(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_region    ON sessions(region, last_active DESC);
`;

/**
 * Columns added to `sessions` after the first release. `CREATE TABLE IF NOT
 * EXISTS` leaves an existing table alone, so a database written by an older
 * build needs them attached here.
 */
const SESSION_COLUMNS: Array<[name: string, definition: string]> = [
  ["prompt_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["completion_tokens", "INTEGER NOT NULL DEFAULT 0"],
];

function migrate(db: Database): void {
  const existing = new Set(
    (db.query(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, definition] of SESSION_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
  }
}

export function initDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(dbPath);
  _db.exec(SCHEMA);
  migrate(_db);
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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initDb, getDb, closeDb } from "./db.ts";
import {
  dbCreateSession,
  dbTouchSession,
  dbUpdateSessionModel,
  dbGetSession,
  dbGetLastSessionForRegion,
  dbListSessions,
  dbInsertMessage,
  dbLoadMessages,
  dbDeleteMessages,
} from "./sessions.repo.ts";
import {
  dbSaveCheckpoint,
  dbGetCheckpoints,
  dbRestoreCheckpoints,
  dbCountCheckpoints,
} from "./checkpoints.repo.ts";
import { dbInsertDecision, dbListDecisions } from "./audit.repo.ts";
import type { ModelMessage } from "../providers/types.ts";

/**
 * The persistence layer, exercised against a real SQLite file rather than a
 * mock — the questions worth asking here (does a structured message survive the
 * JSON round trip, does the cascade fire, does an older database get its new
 * columns) are all questions about SQLite's behaviour, not ours.
 */
let dir: string;
let dbPath: string;

const REGION = "/tmp/some-region";

/** last_active drives every ordering query; set it explicitly so ties can't decide a test. */
function setLastActive(id: string, iso: string) {
  getDb().query(`UPDATE sessions SET last_active = ? WHERE id = ?`).run(iso, id);
}

/** A session only appears in the listings once it has a message. */
function seed(id: string, model = "google:gemini-2.0-flash-exp") {
  dbCreateSession(id, REGION, model);
  dbInsertMessage(id, 0, { role: "user", content: "hello" } as ModelMessage);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-db-"));
  dbPath = path.join(dir, ".codemon", "sessions.db");
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("database file", () => {
  test("initDb creates the .codemon directory and the file", () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  test("every table the app queries exists", () => {
    const names = (
      getDb().query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    for (const table of ["sessions", "messages", "checkpoints", "permission_decisions"]) {
      expect(names).toContain(table);
    }
  });

  test("data survives a close and reopen", () => {
    seed("s1");
    dbTouchSession("s1", { promptTokens: 900, completionTokens: 100 });
    closeDb();

    initDb(dbPath);
    const session = dbGetSession("s1");

    expect(session?.totalTokens).toBe(1000);
    expect(dbLoadMessages("s1")).toHaveLength(1);
  });
});

describe("sessions", () => {
  test("a created session reads back with its region and model", () => {
    dbCreateSession("s1", REGION, "anthropic:claude-sonnet-4-5");

    const session = dbGetSession("s1");
    expect(session?.region).toBe(REGION);
    expect(session?.model).toBe("anthropic:claude-sonnet-4-5");
    expect(session?.messageCount).toBe(0);
  });

  test("total tokens is the sum of the two halves, not a third number", () => {
    seed("s1");
    dbTouchSession("s1", { promptTokens: 4000, completionTokens: 250 });

    const session = dbGetSession("s1");
    expect(session?.promptTokens).toBe(4000);
    expect(session?.completionTokens).toBe(250);
    expect(session?.totalTokens).toBe(4250);
  });

  test("switching model mid-session updates the stored row", () => {
    seed("s1", "google:gemini-2.0-flash-exp");
    dbUpdateSessionModel("s1", "openai:gpt-4o");

    expect(dbGetSession("s1")?.model).toBe("openai:gpt-4o");
  });

  test("listings are per-region, newest first, and carry a message count", () => {
    seed("old");
    seed("new");
    dbInsertMessage("new", 1, { role: "assistant", content: "hi" } as ModelMessage);
    dbCreateSession("elsewhere", "/tmp/other-region", "m");
    dbInsertMessage("elsewhere", 0, { role: "user", content: "x" } as ModelMessage);

    setLastActive("old", "2020-01-01T00:00:00.000Z");
    setLastActive("new", "2030-01-01T00:00:00.000Z");

    const listed = dbListSessions(REGION);
    expect(listed.map((s) => s.id)).toEqual(["new", "old"]);
    expect(listed[0]?.messageCount).toBe(2);
    expect(dbGetLastSessionForRegion(REGION)?.id).toBe("new");
  });

  test("a session that never got a message stays out of the listings", () => {
    dbCreateSession("empty", REGION, "m");

    expect(dbListSessions(REGION)).toEqual([]);
    expect(dbGetLastSessionForRegion(REGION)).toBeNull();
    // …but is still addressable by id, which is how the launch that created it
    // goes on to use it.
    expect(dbGetSession("empty")?.id).toBe("empty");
  });

  test("limit caps the listing", () => {
    for (let i = 0; i < 5; i++) {
      seed(`s${i}`);
      setLastActive(`s${i}`, `20${20 + i}-01-01T00:00:00.000Z`);
    }

    expect(dbListSessions(REGION, 2).map((s) => s.id)).toEqual(["s4", "s3"]);
  });

  test("an unknown id is null rather than a throw", () => {
    expect(dbGetSession("nope")).toBeNull();
  });
});

describe("messages", () => {
  test("structured content survives the round trip", () => {
    // Tool calls and results are arrays of parts. They are stored as JSON, and
    // handing the model back a stringified array would break the next request.
    const assistant = {
      role: "assistant",
      content: [
        { type: "text", text: "Reading the file." },
        { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "a.ts" } },
      ],
    } as unknown as ModelMessage;

    dbCreateSession("s1", REGION, "m");
    dbInsertMessage("s1", 0, { role: "user", content: "what is in a.ts?" } as ModelMessage);
    dbInsertMessage("s1", 1, assistant);

    const loaded = dbLoadMessages("s1");
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.content).toBe("what is in a.ts?");
    expect(loaded[1]?.content).toEqual(assistant.content);
  });

  test("messages come back in seq order, not insertion order", () => {
    dbCreateSession("s1", REGION, "m");
    dbInsertMessage("s1", 2, { role: "user", content: "third" } as ModelMessage);
    dbInsertMessage("s1", 0, { role: "user", content: "first" } as ModelMessage);
    dbInsertMessage("s1", 1, { role: "user", content: "second" } as ModelMessage);

    expect(dbLoadMessages("s1").map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  test("deleting messages leaves the session row", () => {
    seed("s1");
    dbDeleteMessages("s1");

    expect(dbLoadMessages("s1")).toEqual([]);
    expect(dbGetSession("s1")).not.toBeNull();
  });

  test("deleting a session cascades to its messages", () => {
    seed("s1");
    seed("s2");

    getDb().query(`DELETE FROM sessions WHERE id = ?`).run("s1");

    expect(dbLoadMessages("s1")).toEqual([]);
    expect(dbLoadMessages("s2")).toHaveLength(1);
  });
});

describe("checkpoints", () => {
  test("the first checkpoint per file wins, so a rewind reaches the pre-session state", () => {
    dbCreateSession("s1", REGION, "m");
    dbSaveCheckpoint("s1", "/tmp/a.ts", "original", "edit_file");
    dbSaveCheckpoint("s1", "/tmp/a.ts", "after one edit", "edit_file");

    const checkpoints = dbGetCheckpoints("s1");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.originalContent).toBe("original");
    expect(dbCountCheckpoints("s1")).toBe(1);
  });

  test("the same file in a different session is checkpointed again", () => {
    dbCreateSession("s1", REGION, "m");
    dbCreateSession("s2", REGION, "m");
    dbSaveCheckpoint("s1", "/tmp/a.ts", "v1", "edit_file");
    dbSaveCheckpoint("s2", "/tmp/a.ts", "v2", "edit_file");

    expect(dbGetCheckpoints("s2")[0]?.originalContent).toBe("v2");
  });

  test("restoring writes the original content back to disk", () => {
    const file = path.join(dir, "a.ts");
    fs.writeFileSync(file, "original");

    dbCreateSession("s1", REGION, "m");
    dbSaveCheckpoint("s1", file, "original", "edit_file");
    fs.writeFileSync(file, "the agent's version");

    const results = dbRestoreCheckpoints("s1");

    expect(results).toEqual([{ filePath: file, success: true }]);
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });

  test("an unwritable path is reported rather than thrown", () => {
    dbCreateSession("s1", REGION, "m");
    dbSaveCheckpoint("s1", path.join(dir, "no-such-dir", "a.ts"), "original", "write_file");

    const [result] = dbRestoreCheckpoints("s1");

    expect(result?.success).toBe(false);
    expect(result?.error).toBeTruthy();
  });
});

describe("permission decisions", () => {
  const decision = (over: Partial<Parameters<typeof dbInsertDecision>[0]> = {}) => ({
    sessionId: "s1",
    toolName: "bash",
    permissionLevel: "bash",
    decision: "ask-allow" as const,
    args: { command: "ls" },
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  test("a decision round-trips with its arguments", () => {
    dbInsertDecision(decision());

    const [stored] = dbListDecisions("s1");
    expect(stored?.toolName).toBe("bash");
    expect(stored?.decision).toBe("ask-allow");
    expect(JSON.parse(stored!.args)).toEqual({ command: "ls" });
  });

  test("decisions are recorded even without a session row", () => {
    // Evals and sub-agents run unattributed. A foreign key here would take the
    // gate down rather than lose a log line.
    dbInsertDecision(decision({ sessionId: "" }));

    expect(dbListDecisions("")).toHaveLength(1);
  });

  test("oversized arguments are truncated, not stored whole", () => {
    dbInsertDecision(decision({ toolName: "write_file", args: { content: "x".repeat(50_000) } }));

    const [stored] = dbListDecisions("s1");
    expect(stored!.args.length).toBeLessThan(2_100);
    expect(stored!.args).toContain("[truncated]");
  });

  test("decisions come back oldest first, and only for the session asked for", () => {
    dbInsertDecision(decision({ toolName: "read_file", timestamp: "2026-01-01T00:00:01.000Z" }));
    dbInsertDecision(decision({ toolName: "glob", timestamp: "2026-01-01T00:00:02.000Z" }));
    dbInsertDecision(decision({ sessionId: "s2", toolName: "bash" }));

    expect(dbListDecisions("s1").map((d) => d.toolName)).toEqual(["read_file", "glob"]);
    expect(dbListDecisions("s2")).toHaveLength(1);
  });
});

describe("migration from an older database", () => {
  test("columns added after the first release are attached, and existing rows survive", () => {
    closeDb();
    const oldPath = path.join(dir, "old.db");
    const old = new Database(oldPath);
    old.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, region TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL, last_active TEXT NOT NULL,
        total_tokens INTEGER NOT NULL DEFAULT 0
      );
    `);
    old.query(
      `INSERT INTO sessions (id, region, model, started_at, last_active, total_tokens)
       VALUES ('legacy', ?, 'google:gemini-2.0-flash-exp', '2024-01-01', '2024-01-01', 5000)`,
    ).run(REGION);
    old.close();

    initDb(oldPath);

    const columns = (
      getDb().query(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("prompt_tokens");
    expect(columns).toContain("completion_tokens");

    const session = dbGetSession("legacy");
    expect(session?.totalTokens).toBe(5000);
    expect(session?.promptTokens).toBe(0);
  });

  test("running the migration twice is a no-op", () => {
    initDb(dbPath);
    initDb(dbPath);

    seed("s1");
    expect(dbGetSession("s1")?.messageCount).toBe(1);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initDb, closeDb, getDb } from "../storage/db.ts";
import {
  createSession,
  resumeLastSession,
  resumeSpecificSession,
  addMessage,
  updateTokenUsage,
  updateSessionModel,
  getSession,
  endSession,
} from "./session.ts";
import {
  dbGetSession,
  dbListSessions,
  dbInsertMessage,
  dbCreateSession,
} from "../storage/sessions.repo.ts";

/**
 * Session state is module-global and so is the database handle, so each test
 * gets a fresh database of its own rather than sharing one.
 */
const REGION = "/repo";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-session-"));
  dbPath = path.join(dir, "sessions.db");
  initDb(dbPath);
});

afterEach(() => {
  // The current session is module state and `bun test` shares a process across
  // files, so leaving one live leaks it into other files' expectations.
  endSession();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const user = (text: string) => ({ role: "user" as const, content: text });

/** A session row as a build before the prompt/completion split would write it. */
function insertLegacyRow(id: string, totalTokens: number, messages = 0) {
  const now = new Date().toISOString();
  getDb()
    .query(
      `INSERT INTO sessions (id, region, model, started_at, last_active, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, REGION, "google:gemini-2.0-flash-exp", now, now, totalTokens);
  for (let i = 0; i < messages; i++) dbInsertMessage(id, i, user(`stored ${i}`));
}

describe("resuming a session", () => {
  test("keeps the tokens it already cost", () => {
    // The bug: both resume paths started the counters at zero, and the next
    // write pushed those zeros over the real total — permanently.
    const first = createSession(REGION, "m");
    addMessage(user("hello"));
    updateTokenUsage({ promptTokens: 4000, completionTokens: 1000 });
    expect(dbGetSession(first.id)?.totalTokens).toBe(5000);

    const resumed = resumeLastSession(REGION);
    expect(resumed?.id).toBe(first.id);
    expect(resumed?.promptTokensUsed).toBe(4000);
    expect(resumed?.completionTokensUsed).toBe(1000);
    expect(resumed?.totalTokensUsed).toBe(5000);

    addMessage(user("still here?"));
    expect(dbGetSession(first.id)?.totalTokens).toBe(5000);
  });

  test("keeps accumulating on top of the stored total", () => {
    const first = createSession(REGION, "m");
    addMessage(user("hello"));
    updateTokenUsage({ promptTokens: 4000, completionTokens: 1000 });

    resumeLastSession(REGION);
    updateTokenUsage({ promptTokens: 500, completionTokens: 100 });

    const stored = dbGetSession(first.id);
    expect(stored?.promptTokens).toBe(4500);
    expect(stored?.completionTokens).toBe(1100);
    expect(stored?.totalTokens).toBe(5600);
  });

  test("picking one from the picker keeps its tokens too", () => {
    const first = createSession(REGION, "m");
    addMessage(user("hello"));
    updateTokenUsage({ promptTokens: 300, completionTokens: 200 });

    const resumed = resumeSpecificSession(first.id, REGION, "m");
    expect(resumed.totalTokensUsed).toBe(500);

    addMessage(user("again"));
    expect(dbGetSession(first.id)?.totalTokens).toBe(500);
  });

  test("carries the messages back in", () => {
    const first = createSession(REGION, "m");
    addMessage(user("one"));
    addMessage(user("two"));

    expect(resumeLastSession(REGION)?.messages.length).toBe(2);
    expect(resumeSpecificSession(first.id, REGION, "m").messages.length).toBe(2);
  });

  test("a row from before the split carries its total across as completion", () => {
    // `total_tokens` used to mean completion tokens only. Seeding zeros from
    // the two new columns would drop the number on the next write.
    insertLegacyRow("legacy", 5000, 1);

    const resumed = resumeSpecificSession("legacy", REGION, "m");
    expect(resumed.completionTokensUsed).toBe(5000);
    expect(resumed.promptTokensUsed).toBe(0);
    expect(resumed.totalTokensUsed).toBe(5000);

    updateTokenUsage({ promptTokens: 10, completionTokens: 5 });
    expect(dbGetSession("legacy")?.totalTokens).toBe(5015);
  });

  test("resuming when nothing is stored returns null rather than throwing", () => {
    expect(resumeLastSession(REGION)).toBeNull();
  });
});

describe("session rows are written lazily", () => {
  test("starting and quitting without typing leaves nothing behind", () => {
    // Launching used to write a row immediately, so the picker filled with
    // empty sessions — the one screen that has to stay scannable.
    const session = createSession(REGION, "m");

    expect(dbGetSession(session.id)).toBeNull();
    expect(dbListSessions(REGION)).toEqual([]);
  });

  test("the row appears with the first message", () => {
    const session = createSession(REGION, "m");
    addMessage(user("hello"));

    expect(dbGetSession(session.id)?.id).toBe(session.id);
    expect(dbListSessions(REGION).map((s) => s.id)).toEqual([session.id]);
  });

  test("token usage on its own is enough to write the row", () => {
    // A turn can report usage before any message is stored; the foreign key
    // from messages means the row has to exist by then either way.
    const session = createSession(REGION, "m");
    updateTokenUsage({ promptTokens: 10, completionTokens: 5 });

    expect(dbGetSession(session.id)?.totalTokens).toBe(15);
  });

  test("switching model before typing writes nothing, but is remembered", () => {
    const session = createSession(REGION, "google:a");
    updateSessionModel("anthropic:b");
    expect(dbGetSession(session.id)).toBeNull();

    addMessage(user("hello"));
    expect(dbGetSession(session.id)?.model).toBe("anthropic:b");
  });

  test("switching model after typing updates the row", () => {
    const session = createSession(REGION, "google:a");
    addMessage(user("hello"));
    updateSessionModel("anthropic:b");

    expect(dbGetSession(session.id)?.model).toBe("anthropic:b");
  });

  test("writing the row a second time cannot destroy what is already stored", () => {
    // `INSERT OR REPLACE` deletes the conflicting row first, and messages
    // cascade off it — so a stray re-create would empty the session.
    const session = createSession(REGION, "m");
    addMessage(user("hello"));
    updateTokenUsage({ promptTokens: 100, completionTokens: 20 });

    dbCreateSession(session.id, REGION, "m");

    const stored = dbGetSession(session.id);
    expect(stored?.messageCount).toBe(1);
    expect(stored?.totalTokens).toBe(120);
  });

  test("an empty row left by an older build is not offered", () => {
    insertLegacyRow("empty-from-before", 0, 0);

    expect(dbListSessions(REGION)).toEqual([]);
    expect(resumeLastSession(REGION)).toBeNull();
  });
});

describe("the listing carries what the picker shows", () => {
  test("message count comes back with the row", () => {
    // It used to be hardcoded to `messages: []`, so the picker computed zero
    // and rendered nothing.
    createSession(REGION, "m");
    addMessage(user("one"));
    addMessage(user("two"));
    addMessage(user("three"));

    expect(dbListSessions(REGION)[0]?.messageCount).toBe(3);
  });

  test("sessions come back newest first", () => {
    const older = createSession(REGION, "m");
    addMessage(user("older"));
    const newer = createSession(REGION, "m");
    addMessage(user("newer"));

    expect(dbListSessions(REGION).map((s) => s.id)).toEqual([newer.id, older.id]);
    expect(getSession().id).toBe(newer.id);
  });
});

describe("closing the database", () => {
  test("clears the WAL sidecars it leaves beside the file", () => {
    createSession(REGION, "m");
    addMessage(user("hello"));
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

    closeDb();
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

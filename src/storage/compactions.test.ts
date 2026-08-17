import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeDb, initDb } from "./db.ts";
import { dbGetLatestCompaction, dbSaveCompaction } from "./compactions.repo.ts";
import { dbLoadMessages } from "./sessions.repo.ts";
import {
  addMessage,
  createSession,
  endSession,
  getCompaction,
  getSession,
  resumeLastSession,
  saveCompaction,
} from "../core/session.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-compact-db-"));
  initDb(path.join(root, ".codemon", "sessions.db"));
});

afterEach(() => {
  endSession();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("compaction persistence", () => {
  test("a saved summary comes back on resume", () => {
    createSession(root, "test:model");
    addMessage({ role: "user", content: "do the thing" });
    addMessage({ role: "assistant", content: "done" });
    saveCompaction({ summary: "the user asked for the thing; it was done", throughSeq: 1 });

    endSession();
    const resumed = resumeLastSession(root)!;

    expect(resumed.compaction).toEqual({
      summary: "the user asked for the thing; it was done",
      throughSeq: 1,
    });
  });

  test("resuming does not lose the messages the summary covers", () => {
    // Append-only is the point: --rewind and --audit read message rows.
    createSession(root, "test:model");
    addMessage({ role: "user", content: "one" });
    addMessage({ role: "assistant", content: "two" });
    const id = getSession().id;
    saveCompaction({ summary: "S", throughSeq: 1 });

    expect(dbLoadMessages(id)).toHaveLength(2);
  });

  test("the furthest-reaching summary wins, not the most recent", () => {
    // A later automatic compaction that reached less far must not displace an
    // earlier /compact that reached further.
    createSession(root, "test:model");
    const id = getSession().id;
    addMessage({ role: "user", content: "x" });

    dbSaveCompaction(id, { summary: "far", throughSeq: 40 });
    dbSaveCompaction(id, { summary: "near", throughSeq: 10 });

    expect(dbGetLatestCompaction(id)).toEqual({ summary: "far", throughSeq: 40 });
  });

  test("a session with no compaction reads back as null", () => {
    createSession(root, "test:model");
    addMessage({ role: "user", content: "x" });

    expect(getCompaction()).toBeNull();
    expect(dbGetLatestCompaction(getSession().id)).toBeNull();
  });

  test("the summary is held in memory even if the write fails", () => {
    createSession(root, "test:model");
    addMessage({ role: "user", content: "x" });
    closeDb();
    fs.rmSync(root, { recursive: true, force: true });

    // A read-only or vanished database costs persistence, not the summary the
    // session just paid a model call for.
    expect(() => saveCompaction({ summary: "S", throughSeq: 0 })).not.toThrow();
    expect(getCompaction()?.summary).toBe("S");

    root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-compact-db-"));
  });

  test("compactions are dropped with their session", () => {
    createSession(root, "test:model");
    const id = getSession().id;
    addMessage({ role: "user", content: "x" });
    saveCompaction({ summary: "S", throughSeq: 0 });

    const { getDb } = require("./db.ts") as typeof import("./db.ts");
    getDb().query("DELETE FROM sessions WHERE id = ?").run(id);

    expect(dbGetLatestCompaction(id)).toBeNull();
  });
});

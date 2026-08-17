import { describe, test, expect } from "bun:test";
import { stripAnsi, frameLineCount, clearsTerminal } from "./debug-frames.ts";

describe("stripAnsi", () => {
  test("removes colour and cursor sequences but keeps the text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[39m")).toBe("red");
    expect(stripAnsi("\x1b[2K\x1b[1A\x1b[Gline")).toBe("line");
    expect(stripAnsi("\x1b[2J\x1b[3J\x1b[Hcleared")).toBe("cleared");
  });

  test("leaves the box-drawing and glyphs the UI is made of alone", () => {
    const art = "╭───╮ ◓ ❯ ▸ ▪ └ █ ░ ↑ ↓ ─";
    expect(stripAnsi(`\x1b[32m${art}\x1b[39m`)).toBe(art);
  });

  test("survives text with no escapes at all", () => {
    expect(stripAnsi("plain")).toBe("plain");
    expect(stripAnsi("")).toBe("");
  });
});

describe("frameLineCount", () => {
  test("counts the rows a frame will occupy, not its newlines", () => {
    // Three lines, two separators — a frame does not end with a newline.
    expect(frameLineCount("a\nb\nc")).toBe(3);
    expect(frameLineCount("only one")).toBe(1);
    expect(frameLineCount("")).toBe(0);
  });

  test("a trailing newline is a row of its own", () => {
    // Which is the point: it is the row that tips a full-height frame over the
    // bottom of the screen.
    expect(frameLineCount("a\n")).toBe(2);
  });

  test("escape sequences do not count as content", () => {
    const framed = "\x1b[2K\x1b[1A" + "\x1b[32mrow one\x1b[39m\n\x1b[32mrow two\x1b[39m";
    expect(frameLineCount(framed)).toBe(2);
  });
});

describe("clearsTerminal", () => {
  test("spots Ink's full-screen wipe", () => {
    // The fallback Ink takes when it cannot update a frame in place — the one
    // thing in the log that means the whole screen was thrown away and redrawn.
    expect(clearsTerminal("\x1b[2J\x1b[3J\x1b[Hcontent")).toBe(true);
  });

  test("an ordinary in-place update is not one", () => {
    expect(clearsTerminal("\x1b[2K\x1b[1Gjust this row")).toBe(false);
    expect(clearsTerminal("plain text")).toBe(false);
  });
});

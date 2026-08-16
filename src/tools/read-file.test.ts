import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileTool } from "./read-file.ts";
import { setProjectRoot, getProjectRoot } from "../sandbox/path-jail.ts";

/**
 * Without a size or type check, a lockfile, minified bundle or binary would go
 * into the message history and stay there for the rest of the session.
 */

interface ReadResult {
  content?: string;
  path?: string;
  start_line?: number;
  truncated?: boolean;
  message?: string;
  error?: string;
}

function runRead(args: Record<string, unknown>): Promise<ReadResult> {
  return readFileTool.execute(readFileTool.parameters.parse(args)) as Promise<ReadResult>;
}

const CAP_BYTES = 256 * 1024;

describe("read_file", () => {
  const originalRoot = getProjectRoot();
  let root: string;

  /** Line N of the big fixture, without its newline. */
  const bigLine = (n: number) => `line ${String(n).padStart(6, "0")} ${"x".repeat(40)}`;
  const BIG_LINES = 8000; // ~ 400 KB, comfortably over the cap

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-read-"));

    fs.writeFileSync(path.join(root, "small.ts"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    // A NUL past the sniff window should not be enough to call a file binary.
    fs.writeFileSync(
      path.join(root, "late-nul.txt"),
      Buffer.concat([Buffer.from("a".repeat(9000)), Buffer.from([0x00])]),
    );

    const big = Array.from({ length: BIG_LINES }, (_, i) => bigLine(i + 1)).join("\n") + "\n";
    fs.writeFileSync(path.join(root, "big.log"), big);
    expect(fs.statSync(path.join(root, "big.log")).size).toBeGreaterThan(CAP_BYTES);
  });

  afterAll(() => {
    setProjectRoot(originalRoot);
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    setProjectRoot(root);
  });

  test("reads a small text file whole", async () => {
    const result = await runRead({ path: "small.ts" });
    expect(result.content).toBe("one\ntwo\nthree\n");
    expect(result.error).toBeUndefined();
  });

  test("reads a line range out of a small file", async () => {
    const result = await runRead({ path: "small.ts", start_line: 2, end_line: 3 });
    expect(result.content).toBe("two\nthree");
  });

  test("refuses a binary file instead of returning mojibake", async () => {
    const result = await runRead({ path: "binary.bin" });
    expect(result.content).toBeUndefined();
    expect(result.error).toMatch(/binary/i);
  });

  test("does not call a file binary for a NUL past the sniff window", async () => {
    const result = await runRead({ path: "late-nul.txt", start_line: 1, end_line: 1 });
    expect(result.error).toBeUndefined();
  });

  test("refuses a whole-file read over the size cap, and says how to narrow it", async () => {
    const result = await runRead({ path: "big.log" });
    expect(result.content).toBeUndefined();
    expect(result.error).toMatch(/over the .* limit/i);
    expect(result.error).toMatch(/start_line/);
  });

  test("the range the oversize error suggests actually works", async () => {
    const result = await runRead({ path: "big.log", start_line: 4000, end_line: 4002 });
    expect(result.content).toBe([bigLine(4000), bigLine(4001), bigLine(4002)].join("\n"));
    expect(result.truncated).toBeUndefined();
  });

  test("caps a range that is itself over the limit, and says so", async () => {
    const result = await runRead({ path: "big.log", start_line: 1, end_line: BIG_LINES });
    expect(Buffer.byteLength(result.content ?? "")).toBeLessThanOrEqual(CAP_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.message).toMatch(/narrower range/i);
  });

  test("reports a start_line past the end of the file", async () => {
    const result = await runRead({ path: "small.ts", start_line: 99 });
    expect(result.error).toMatch(/only 3 lines/i);
  });

  test("reports an inverted range", async () => {
    const result = await runRead({ path: "small.ts", start_line: 3, end_line: 2 });
    expect(result.error).toMatch(/before start_line/i);
  });

  test("still rejects a path outside the project root", async () => {
    expect(runRead({ path: "/etc/passwd" })).rejects.toThrow("Access denied");
  });
});

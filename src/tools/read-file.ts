import * as fs from "fs";
import { z } from "zod";
import { jailPath } from "../sandbox/path-jail.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  path: z.string().describe("Path to the file to read, relative to the project root"),
  start_line: z.number().int().positive().optional().describe("Start line (1-indexed, inclusive)"),
  end_line: z.number().int().positive().optional().describe("End line (1-indexed, inclusive)"),
});

/**
 * Most content one call will return. What comes back is resent on every turn,
 * so the cap is about the conversation rather than about memory.
 */
const MAX_CONTENT_BYTES = 256 * 1024;

/** How much of the head to inspect before deciding a file is binary. */
const SNIFF_BYTES = 8192;

const READ_CHUNK_BYTES = 64 * 1024;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Reads at most `n` bytes from the start of the file. */
function readHead(absPath: string, n: number): Buffer {
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.allocUnsafe(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

interface RangeRead {
  content: string;
  /** True if the range was cut short at `maxBytes`. */
  truncated: boolean;
  /** The last line number reached, whether or not it was kept. */
  lastLine: number;
}

/**
 * Reads lines `from`..`to` (1-indexed, inclusive) a chunk at a time, stopping as
 * soon as the window is filled so a large file is never pulled into memory.
 */
function readLineRange(absPath: string, from: number, to: number, maxBytes: number): RangeRead {
  const fd = fs.openSync(absPath, "r");
  const decoder = new TextDecoder();
  const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const kept: string[] = [];

  let keptBytes = 0;
  let carry = "";
  let lineNo = 0;
  let truncated = false;
  let done = false;

  const push = (line: string) => {
    lineNo++;
    if (lineNo < from) return;
    if (lineNo > to) {
      done = true;
      return;
    }
    if (keptBytes + line.length + 1 > maxBytes) {
      truncated = true;
      done = true;
      return;
    }
    kept.push(line);
    keptBytes += line.length + 1;
  };

  try {
    while (!done) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK_BYTES, null);
      if (n === 0) {
        carry += decoder.decode(); // flush any half-decoded character
        // Final line, if the file did not end with a newline.
        if (carry !== "") push(carry);
        break;
      }
      const parts = (carry + decoder.decode(buf.subarray(0, n), { stream: true })).split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        push(part);
        if (done) break;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return { content: kept.join("\n"), truncated, lastLine: lineNo };
}

export const readFileTool: ToolDefinition<typeof schema> = {
  name: "read_file",
  description:
    "Read the contents of a text file. Optionally specify start_line and end_line to read a specific range — required for files over 256 KB. Returns the file content as a string.",
  parameters: schema,
  permissionLevel: "read",
  async execute({ path: filePath, start_line, end_line }) {
    const absPath = jailPath(filePath);

    if (!fs.existsSync(absPath)) {
      return { error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      return { error: `${filePath} is a directory. Use list_dir to explore directories.` };
    }

    // Binaries read as mojibake and are worth nothing in the transcript, so
    // refuse them by the one signal that is cheap and reliable: a NUL byte.
    const nulAt = readHead(absPath, SNIFF_BYTES).indexOf(0);
    if (nulAt !== -1) {
      return {
        error:
          `${filePath} looks like a binary file (NUL byte at offset ${nulAt}), not text. ` +
          `Use bash with a tool that understands the format if you need to inspect it.`,
      };
    }

    const hasRange = start_line !== undefined || end_line !== undefined;

    if (!hasRange) {
      if (stat.size > MAX_CONTENT_BYTES) {
        return {
          error:
            `${filePath} is ${humanSize(stat.size)}, over the ${humanSize(MAX_CONTENT_BYTES)} limit for a whole-file read. ` +
            `Read part of it with start_line / end_line, or search it with grep.`,
        };
      }
      return { content: fs.readFileSync(absPath, "utf8"), path: filePath };
    }

    const from = start_line ?? 1;
    const to = end_line ?? Infinity;
    if (to < from) {
      return { error: `end_line (${end_line}) is before start_line (${start_line}).` };
    }

    const range = readLineRange(absPath, from, to, MAX_CONTENT_BYTES);

    if (range.lastLine < from) {
      return {
        error: `${filePath} has only ${range.lastLine} lines; start_line ${from} is past the end.`,
      };
    }

    return {
      content: range.content,
      path: filePath,
      start_line: from,
      ...(range.truncated
        ? {
            truncated: true,
            message:
              `Stopped at the ${humanSize(MAX_CONTENT_BYTES)} limit. Request a narrower range to see more.`,
          }
        : {}),
    };
  },
};

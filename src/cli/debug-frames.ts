/**
 * Repaint probe — ground truth for "the screen flickered".
 *
 * A UI flickers when a small change rewrites a large part of the screen, so this
 * wraps stdout and measures it rather than reasoning from the source. In the log,
 * `lines` is how much of the screen an update repainted (one or two for a single
 * changed row; near the terminal height means something forced a full repaint),
 * and `cleared` means Ink fell back to wiping the terminal outright.
 *
 * Off unless CODEMON_DEBUG_FRAMES is set, and it never throws — a probe that can
 * take the app down is worse than no probe.
 */
import * as fs from "fs";
import * as path from "path";
import { getUserConfigDir } from "../config/paths.ts";

/** CSI sequences and OSC strings. Enough to reduce a frame to its visible text. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * Lines of text a chunk paints.
 *
 * The escapes come off first, so cursor moves and erases are not counted as
 * content. A frame does not end in a newline, hence the line count rather than
 * the separator count.
 */
export function frameLineCount(chunk: string): number {
  const text = stripAnsi(chunk);
  if (text === "") return 0;
  return text.split("\n").length;
}

/** Ink wipes the whole terminal when it cannot update a frame in place. */
export function clearsTerminal(chunk: string): boolean {
  return chunk.includes("\x1b[2J");
}

/** What the app believed it was drawing. Set from the render body. */
let stamp: Record<string, unknown> = {};

/** No-op unless the probe is installed, so it is safe to call unconditionally. */
export function stampFrame(next: Record<string, unknown>): void {
  if (installed) stamp = next;
}

let installed = false;

export interface FrameProbeHandle {
  logPath: string;
  uninstall: () => void;
}

/**
 * Wraps `process.stdout.write` for the life of the process.
 *
 * Returns null when the probe is disabled so the caller can print nothing.
 * `CODEMON_DEBUG_FRAMES=1` logs to ~/.codemon/frames.log; any other value is
 * taken as the path to log to.
 */
export function installFrameProbe(): FrameProbeHandle | null {
  const env = process.env.CODEMON_DEBUG_FRAMES;
  if (!env || env === "0" || env === "") return null;
  if (installed) return null;

  const logPath =
    env === "1" ? path.join(getUserConfigDir(), "frames.log") : path.resolve(env);

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "");
  } catch {
    return null;
  }

  const original = process.stdout.write.bind(process.stdout);
  let seq = 0;
  let heavyCount = 0;
  let clearedCount = 0;
  /** Text is kept for the first few heavy updates only; a full dump is unreadable. */
  let dumpsLeft = 12;

  const append = (record: unknown) => {
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    } catch {
      // A full disk is not a reason to kill the session being debugged.
    }
  };

  const probe = (chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      if (typeof chunk === "string" && chunk.length > 0) {
        // `process.stdout.rows` is 0 when stdout is not a terminal, so fall back
        // to the height the app itself is laying out to.
        const rows = process.stdout.rows || Number(stamp.rows) || 0;
        const lines = frameLineCount(chunk);
        const cleared = clearsTerminal(chunk);
        // Rewriting more than half the screen for one changed row is what the
        // eye reads as a flicker.
        const heavy = rows > 0 && lines > rows / 2;

        seq++;
        if (heavy) heavyCount++;
        if (cleared) clearedCount++;

        const dump = (heavy || cleared) && dumpsLeft > 0;
        if (dump) dumpsLeft--;

        append({
          seq,
          lines,
          rows,
          heavy,
          cleared,
          bytes: chunk.length,
          state: stamp,
          ...(dump ? { painted: stripAnsi(chunk).split("\n") } : {}),
        });
      }
    } catch {
      // Never let instrumentation break the write it is measuring.
    }
    return original(chunk as string, ...(rest as []));
  };

  process.stdout.write = probe as typeof process.stdout.write;
  installed = true;

  return {
    logPath,
    uninstall: () => {
      process.stdout.write = original;
      installed = false;
      append({ summary: true, updates: seq, heavy: heavyCount, cleared: clearedCount });
    },
  };
}

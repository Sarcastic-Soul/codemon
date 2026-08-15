import { getProjectRoot } from "./path-jail.ts";
import { logger } from "../utils/logger.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** True if stdout or stderr hit the capture cap and the rest was discarded. */
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Most output captured per stream. A command that produces more has the rest
 * dropped as it arrives rather than buffered and trimmed afterwards — callers
 * show a few thousand characters at most, so holding a gigabyte first only
 * risks the process.
 */
const MAX_CAPTURE_BYTES = 1024 * 1024;

/**
 * Drains a stream up to `maxBytes`, then stops consuming it.
 *
 * Cancelling closes our end of the pipe, so a runaway writer gets EPIPE instead
 * of being allowed to keep filling memory.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const room = maxBytes - bytes;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });

      if (bytes >= maxBytes) {
        truncated = true;
        break;
      }
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { text, truncated };
}

/**
 * Spawns argv directly and captures its output.
 * - cwd is forced to the project root
 * - Timeout kills the process if exceeded
 * - Output is capped per stream at `MAX_CAPTURE_BYTES`
 * - A missing binary comes back as exit code 127 rather than throwing, so
 *   callers can probe for optional tools the same way a shell would report them
 */
async function spawnCaptured(argv: string[], timeoutMs: number): Promise<ExecResult> {
  const cwd = getProjectRoot();

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env: {
        ...process.env,
        // Remove potentially dangerous env vars in the future for stricter sandboxing
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("spawn failed", { argv, message });
    return { stdout: "", stderr: message, exitCode: 127, timedOut: false, truncated: false };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    readCapped(proc.stdout, MAX_CAPTURE_BYTES),
    readCapped(proc.stderr, MAX_CAPTURE_BYTES),
    proc.exited,
  ]);

  clearTimeout(timer);

  const truncated = stdout.truncated || stderr.truncated;
  logger.info("exec result", { exitCode, timedOut, truncated });

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: exitCode ?? 0,
    timedOut,
    truncated,
  };
}

/**
 * Runs a command string through `bash -c`.
 *
 * The string is parsed by a shell, so every metacharacter in it is live. Use
 * this only for commands the user explicitly asked to run (the `bash` tool) or
 * for fully static command strings. Never assemble one of these by
 * interpolating tool arguments — reach for `shellExecArgv` instead.
 */
export async function shellExec(
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExecResult> {
  logger.info("shellExec", { command, cwd: getProjectRoot(), timeoutMs });
  return spawnCaptured(["bash", "-c", command], timeoutMs);
}

/**
 * Runs a program directly from an argv array, with no shell in between.
 *
 * Every element is handed to the process verbatim, so quotes, semicolons,
 * backticks and `$(…)` in an argument are ordinary characters rather than
 * syntax. This is the only safe way to run a command built from
 * model-supplied arguments.
 */
export async function shellExecArgv(
  argv: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExecResult> {
  if (argv.length === 0) {
    throw new Error("shellExecArgv: argv must contain at least the program name");
  }
  logger.info("shellExecArgv", { argv, cwd: getProjectRoot(), timeoutMs });
  return spawnCaptured(argv, timeoutMs);
}

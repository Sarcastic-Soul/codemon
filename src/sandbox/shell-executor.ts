import { getProjectRoot } from "./path-jail.ts";
import { logger } from "../utils/logger.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Restricted subprocess wrapper.
 * - cwd is forced to the project root
 * - Timeout kills the process if exceeded
 * - stdout/stderr are captured and returned
 */
export async function shellExec(
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExecResult> {
  const cwd = getProjectRoot();
  logger.info("shellExec", { command, cwd, timeoutMs });

  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    env: {
      ...process.env,
      // Remove potentially dangerous env vars in the future for stricter sandboxing
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(async () => {
    timedOut = true;
    proc.kill(9);
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  logger.info("shellExec result", { exitCode, timedOut });

  return { stdout, stderr, exitCode: exitCode ?? 0, timedOut };
}

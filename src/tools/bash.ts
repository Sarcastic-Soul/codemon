import { z } from "zod";
import { shellExec } from "../sandbox/shell-executor.ts";
import { dockerExec, ensureSandbox } from "../sandbox/docker-executor.ts";
import { getProjectRoot } from "../sandbox/path-jail.ts";
import { getCurrentConfig } from "../core/provider-instance.ts";
import { logger } from "../utils/logger.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  command: z.string().describe("The shell command to run"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout in milliseconds. Default is 30000 (30 seconds)."),
  allow_network: z
    .boolean()
    .optional()
    .default(false)
    .describe("Allow network access in Docker sandbox mode (ignored in subprocess mode)."),
});

export const bashTool: ToolDefinition<typeof schema> = {
  name: "bash",
  description:
    "Execute a shell command. In standard mode runs in the project directory with a subprocess. In Docker sandbox mode runs in an isolated container with the project mounted.",
  parameters: schema,
  permissionLevel: "bash",
  async execute({ command, timeout_ms, allow_network = false }) {
    let config: { sandbox?: string; timeout?: number };
    try {
      config = getCurrentConfig();
    } catch {
      config = {}; // No config set (e.g. in tests)
    }

    const timeout = timeout_ms ?? (config.timeout ?? 30_000);

    if (config.sandbox === "docker") {
      logger.info("bash: using Docker sandbox");
      const sandboxReady = await ensureSandbox();

      if (sandboxReady) {
        const result = await dockerExec(command, getProjectRoot(), {
          timeoutMs: timeout,
          allowNetwork: allow_network,
        });
        return {
          stdout: result.stdout.slice(0, 20000),
          stderr: result.stderr.slice(0, 5000),
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          sandbox: "docker",
        };
      }

      logger.warn("bash: Docker sandbox unavailable, falling back to subprocess");
    }

    // Subprocess mode (default)
    const result = await shellExec(command, timeout);
    return {
      stdout: result.stdout.slice(0, 20000),
      stderr: result.stderr.slice(0, 5000),
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      sandbox: "subprocess",
    };
  },
};

/**
 * `codemon run "<prompt>"` — one prompt, no TUI.
 *
 * The point is scriptability: CI, git hooks, `codemon run … > out.txt`. So the
 * output contract is narrow on purpose — the assistant's reply goes to stdout
 * and nothing else does, tool activity goes to stderr, and the exit code says
 * what happened without anyone having to grep prose for it.
 */
import { runAgent, MAX_TURNS_REASON, type AgentEvent } from "../core/agent-loop.ts";
import { createSession } from "../core/session.ts";
import { loadAgentRules } from "../config/load-agent-rules.ts";
import { startMcpServers, stopMcpServers } from "../mcp/index.ts";
import { onShutdown, type Bootstrapped } from "../core/bootstrap.ts";
import { buildSystemPrompt } from "../core/system-prompt.ts";
import type { FlagValue } from "./parse-args.ts";

/** Exit codes. Distinct values are what make this usable in a git hook. */
export const EXIT = {
  ok: 0,
  /** Provider or config problem, or the stream itself failed. */
  error: 1,
  /** Ran out of tool-calling turns without finishing. */
  maxTurns: 2,
  /** A tool needed confirmation and there was no one to ask. */
  denied: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Read a prompt piped in on stdin. Empty when stdin is a terminal. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  } catch {
    return "";
  }
}

/** One-line summary of a tool call for the stderr activity log. */
function toolLine(event: Extract<AgentEvent, { type: "tool-start" }>): string {
  const arg =
    event.args.path ?? event.args.file_path ?? event.args.command ?? event.args.pattern ?? "";
  const suffix = arg ? ` ${String(arg).slice(0, 100)}` : "";
  return `⚙ ${event.toolName}${suffix}`;
}

export interface HeadlessOptions {
  boot: Bootstrapped;
  prompt: string;
  json: boolean;
  maxTurns?: number;
}

export async function runHeadless(options: HeadlessOptions): Promise<ExitCode> {
  const { boot, prompt, json } = options;

  if (!boot.provider) {
    process.stderr.write(`${boot.keyError ?? "No provider configured."}\n`);
    return EXIT.error;
  }

  if (prompt.trim() === "") {
    process.stderr.write('No prompt given. Usage: codemon run "<prompt>"\n');
    return EXIT.error;
  }

  const config = {
    ...boot.config,
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
  };

  // Sessions persist for headless runs too, so --audit and --rewind work
  // against them. That matters most in CI, where nobody watched it happen.
  createSession(boot.projectRoot, config.model);

  // Servers come up before the single turn rather than in the background: a
  // headless run has no "next turn" for a late server to appear on.
  const mcp = await startMcpServers(boot.projectRoot);
  onShutdown(stopMcpServers);
  if (mcp.failed.length > 0 && !json) {
    for (const f of mcp.failed) {
      process.stderr.write(`⚠ MCP server "${f.server}" failed to start: ${f.error}\n`);
    }
  }

  const systemPrompt = buildSystemPrompt({
    config,
    projectRoot: boot.projectRoot,
    agentRules: loadAgentRules(boot.projectRoot),
    planMode: config.planMode,
  });

  let exitCode: ExitCode = EXIT.ok;

  try {
    for await (const event of runAgent(prompt, boot.provider, config, systemPrompt)) {
      if (json) {
        // `permission-required` carries a function; strip it so the line is
        // serialisable and a wrapper can still see what was asked for.
        const { resolve: _resolve, ...rest } = event as AgentEvent & { resolve?: unknown };
        process.stdout.write(`${JSON.stringify(rest)}\n`);
      }

      switch (event.type) {
        case "text":
          if (!json) process.stdout.write(event.text);
          break;

        case "tool-start":
          if (!json) process.stderr.write(`${toolLine(event)}\n`);
          break;

        case "tool-error":
          if (!json) process.stderr.write(`✗ ${event.toolName}: ${event.error}\n`);
          break;

        case "compaction":
          if (!json) {
            process.stderr.write(`↺ compacted ${event.droppedMessages} earlier messages\n`);
          }
          break;

        case "permission-required":
          // Denied, not auto-allowed. A git hook that starts running `rm`
          // because nobody was watching is exactly what this avoids;
          // `--mode yolo` is the explicit opt-in, and CI is where it belongs.
          process.stderr.write(
            `✗ ${event.toolName}: denied — ${event.permissionLevel}-level tools need ` +
              `confirmation in "${config.permissionMode}" mode and there is no way to ask. ` +
              `Re-run with --mode yolo to allow them.\n`,
          );
          exitCode = EXIT.denied;
          event.resolve("deny");
          break;

        case "finish":
          if (event.reason === MAX_TURNS_REASON) exitCode = EXIT.maxTurns;
          break;

        case "error":
          process.stderr.write(`Error: ${event.error.message}\n`);
          exitCode = EXIT.error;
          break;
      }
    }
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.error;
  }

  if (!json) process.stdout.write("\n");
  return exitCode;
}

/** Resolve the prompt from argv, falling back to stdin. */
export async function resolvePrompt(rest: string): Promise<string> {
  return rest !== "" ? rest : await readStdin();
}

/** Headless-specific flags, read off the parsed flag bag. */
export function headlessFlags(flags: Record<string, FlagValue>): { json: boolean; maxTurns?: number } {
  const raw = flags["max-turns"];
  const maxTurns = typeof raw === "string" ? Number(raw) : undefined;
  return {
    json: flags.json === true,
    ...(maxTurns && Number.isFinite(maxTurns) ? { maxTurns: Math.floor(maxTurns) } : {}),
  };
}

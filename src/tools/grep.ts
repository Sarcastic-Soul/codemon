import { z } from "zod";
import * as path from "path";
import { shellExecArgv } from "../sandbox/shell-executor.ts";
import { jailPath, getProjectRoot } from "../sandbox/path-jail.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  pattern: z.string().describe("The search pattern (regex or literal string)"),
  path: z
    .string()
    .optional()
    .describe("Directory or file to search in. Defaults to the project root."),
  include: z.string().optional().describe("Glob pattern for files to include (e.g. '*.ts')"),
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .default(2)
    .describe("Lines of context around each match"),
  case_sensitive: z.boolean().optional().default(true),
});

const MAX_COUNT_PER_FILE = 100;
const MAX_OUTPUT_CHARS = 15000;
const SKIP_DIRS = ["node_modules", ".git", "dist"];

/**
 * With line numbers on — which both branches below force — a match prints as
 * `[path:]line:text` and a context line as `[path-]line-text`, with `--`
 * between non-adjacent groups. The delimiter around the line number is what
 * tells the two apart, and whichever shape appears first in the line is the one
 * that came from the delimiter: anything later is content that happens to look
 * like one (`const t = "a:12:b"`).
 */
const MATCH_FIELD = /(?:^|:)\d+:/;
const CONTEXT_FIELD = /(?:^|-)\d+-/;

function isMatchLine(line: string): boolean {
  const match = MATCH_FIELD.exec(line);
  if (!match) return false;
  const context = CONTEXT_FIELD.exec(line);
  return !context || match.index < context.index;
}

/**
 * Counts matched lines, not output lines. With context enabled the output is
 * mostly context lines and `--` separators, which used to be counted as matches
 * and overstated the total by roughly the context width.
 */
function countMatches(stdout: string, contextLines: number): number {
  const lines = stdout.split("\n").filter((l) => l !== "" && l !== "--");
  // Without context every remaining line is a match, so nothing to infer.
  if (contextLines === 0) return lines.length;
  return lines.filter(isMatchLine).length;
}

/** Whether ripgrep is on PATH. Probed once — it cannot change mid-run. */
let ripgrepAvailable: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (ripgrepAvailable === null) {
    const probe = await shellExecArgv(["rg", "--version"], 5000);
    ripgrepAvailable = probe.exitCode === 0;
  }
  return ripgrepAvailable;
}

export const grepTool: ToolDefinition<typeof schema> = {
  name: "grep",
  description:
    "Search for a pattern in files using ripgrep (falls back to grep). Returns matching lines with context. Use this to find function definitions, TODO comments, imports, etc.",
  parameters: schema,
  permissionLevel: "read",
  async execute({ pattern, path: searchPath, include, context_lines = 2, case_sensitive = true }) {
    // Confine the search to the project root, then express the target relative
    // to it so matched paths come back project-relative.
    const absolute = jailPath(searchPath ?? ".");
    const target = path.relative(getProjectRoot(), absolute) || ".";

    // Built as an argv array and spawned without a shell: `pattern`, `include`
    // and `target` reach the process verbatim, so metacharacters in them are
    // ordinary text. `-e` keeps a pattern starting with `-` from being read as
    // a flag, and `--` does the same for the path.
    const argv = (await hasRipgrep())
      ? [
          "rg",
          `--max-count=${MAX_COUNT_PER_FILE}`,
          // Line numbers are useful to the caller in their own right, and they
          // are what `countMatches` reads to tell a match from its context. rg
          // omits them for a single explicit file unless asked.
          "--line-number",
          "-C",
          String(context_lines),
          ...(case_sensitive ? [] : ["-i"]),
          ...(include ? ["--glob", include] : []),
          "-e",
          pattern,
          "--",
          target,
        ]
      : [
          "grep",
          "-rn",
          `-m${MAX_COUNT_PER_FILE}`,
          // ripgrep skips these by default; plain grep needs telling, and the
          // old `| head -200` pipe is gone to cut the output down after the fact
          ...SKIP_DIRS.map((d) => `--exclude-dir=${d}`),
          "-C",
          String(context_lines),
          ...(case_sensitive ? [] : ["-i"]),
          ...(include ? [`--include=${include}`] : []),
          "-e",
          pattern,
          "--",
          target,
        ];

    const result = await shellExecArgv(argv);

    // Both tools use exit 1 for "no matches" and 2+ for a real failure. The old
    // pipeline hid that distinction; surface it rather than reporting an error
    // as an empty result.
    if (result.exitCode >= 2 && result.stdout.trim() === "") {
      throw new Error(
        `Search failed (exit ${result.exitCode}): ${result.stderr.trim() || "unknown error"}`,
      );
    }

    if (result.stdout.trim() === "") {
      return { matches: "", count: 0, truncated: false, message: "No matches found" };
    }

    const matches = result.stdout.slice(0, MAX_OUTPUT_CHARS);
    return {
      matches,
      count: countMatches(result.stdout, context_lines),
      truncated: result.truncated || matches.length < result.stdout.length,
    };
  },
};

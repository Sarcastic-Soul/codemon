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
 * With line numbers on, a match prints as `[path:]line:text` and a context line
 * as `[path-]line-text`. Whichever shape appears first is the real delimiter —
 * anything later is content that happens to look like one (`const t = "a:12:b"`).
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
 * Counts matched lines, not output lines — with context enabled the output is
 * mostly context lines and `--` separators.
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

    // Spawned without a shell, so metacharacters in the arguments are ordinary
    // text. `-e` and `--` keep a leading `-` from being read as a flag.
    const argv = (await hasRipgrep())
      ? [
          "rg",
          `--max-count=${MAX_COUNT_PER_FILE}`,
          // `countMatches` reads these to tell a match from its context, and rg
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
          // ripgrep skips these by default; plain grep needs telling.
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

    // Both tools use exit 1 for "no matches" and 2+ for a real failure — don't
    // report the latter as an empty result.
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

import { z } from "zod";
import { shellExec } from "../sandbox/shell-executor.ts";
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

export const grepTool: ToolDefinition<typeof schema> = {
  name: "grep",
  description:
    "Search for a pattern in files using ripgrep (falls back to grep). Returns matching lines with context. Use this to find function definitions, TODO comments, imports, etc.",
  parameters: schema,
  permissionLevel: "read",
  async execute({ pattern, path: searchPath, include, context_lines = 2, case_sensitive = true }) {
    // Try ripgrep first, fall back to grep
    const rg = await shellExec("which rg", 5000);
    const useRg = rg.exitCode === 0;

    let command: string;
    const escapedPattern = pattern.replace(/'/g, "'\\''");
    const targetPath = searchPath ?? ".";
    const caseFlagRg = case_sensitive ? "" : "-i";
    const caseFlagGrep = case_sensitive ? "" : "-i";
    const includeFlagRg = include ? `--glob '${include}'` : "";
    const includeFlagGrep = include ? `--include='${include}'` : "";

    if (useRg) {
      command = `rg '${escapedPattern}' ${caseFlagRg} -C ${context_lines} ${includeFlagRg} --max-count=100 '${targetPath}'`;
    } else {
      command = `grep -rn '${escapedPattern}' ${caseFlagGrep} -C ${context_lines} ${includeFlagGrep} '${targetPath}' | head -200`;
    }

    const result = await shellExec(command);
    if (result.exitCode !== 0 && result.stdout.trim() === "") {
      return { matches: "", count: 0, message: "No matches found" };
    }

    const lines = result.stdout.trim().split("\n");
    return { matches: result.stdout.slice(0, 15000), count: lines.length };
  },
};

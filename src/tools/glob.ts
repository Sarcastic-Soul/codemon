import { z } from "zod";
import { shellExec } from "../sandbox/shell-executor.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  pattern: z
    .string()
    .describe(
      "Glob pattern to match files against (e.g. '**/*.ts', 'src/**/*.json', '*.md')",
    ),
  path: z
    .string()
    .optional()
    .describe("Base directory to search from. Defaults to the project root."),
  exclude: z
    .string()
    .optional()
    .describe("Glob pattern for paths to exclude (e.g. 'node_modules/**')"),
});

export const globTool: ToolDefinition<typeof schema> = {
  name: "glob",
  description:
    "Find files matching a glob pattern within the project. Returns a list of matching file paths.",
  parameters: schema,
  permissionLevel: "read",
  async execute({ pattern, path: basePath, exclude }) {
    const base = basePath ?? ".";
    const excludeFlag = exclude ? `--exclude='${exclude}'` : "";
    // Use find with shell glob expansion
    const command = `find '${base}' -type f -name '${pattern}' ${excludeFlag} | grep -v node_modules | grep -v '.git' | head -200`;
    const result = await shellExec(command);

    if (result.exitCode !== 0 || result.stdout.trim() === "") {
      // Fallback: use bash glob
      const fallback = await shellExec(
        `bash -c "shopt -s globstar; ls ${base}/${pattern} 2>/dev/null | head -200"`,
      );
      const files = fallback.stdout.trim().split("\n").filter(Boolean);
      return { files, count: files.length };
    }

    const files = result.stdout.trim().split("\n").filter(Boolean);
    return { files, count: files.length };
  },
};

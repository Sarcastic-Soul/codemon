import { z } from "zod";
import * as path from "path";
import { jailPath, getProjectRoot, isInsideJail } from "../sandbox/path-jail.ts";
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

const MAX_RESULTS = 200;

/** Never worth returning, and expensive to walk. */
const ALWAYS_EXCLUDE = ["**/node_modules/**", "**/.git/**"];

export const globTool: ToolDefinition<typeof schema> = {
  name: "glob",
  description:
    "Find files matching a glob pattern within the project. Returns a list of matching file paths.",
  parameters: schema,
  permissionLevel: "read",
  async execute({ pattern, path: basePath, exclude }) {
    // Matching happens in-process via Bun.Glob — no subprocess and no shell, so
    // `pattern`, `path` and `exclude` are never parsed as command syntax.
    const base = jailPath(basePath ?? ".");
    const root = getProjectRoot();

    const excludeGlobs = [...ALWAYS_EXCLUDE, ...(exclude ? [exclude] : [])].map(
      (p) => new Bun.Glob(p),
    );

    const files: string[] = [];
    let truncated = false;

    try {
      for await (const relative of new Bun.Glob(pattern).scan({
        cwd: base,
        onlyFiles: true,
        followSymlinks: false,
        dot: true,
      })) {
        if (excludeGlobs.some((g) => g.match(relative))) continue;

        // A `..` segment in the pattern could still walk out of the base —
        // drop anything that lands outside the jail.
        const absolute = path.resolve(base, relative);
        if (!isInsideJail(absolute)) continue;

        files.push(path.relative(root, absolute));
        if (files.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot search "${path.relative(root, base) || "."}": ${message}`,
      );
    }

    files.sort();
    return { files, count: files.length, truncated };
  },
};

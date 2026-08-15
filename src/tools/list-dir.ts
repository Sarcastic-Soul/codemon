import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { jailPath, getProjectRoot } from "../sandbox/path-jail.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory to list, relative to the project root. Defaults to the project root."),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, lists all files recursively"),
  max_depth: z
    .number()
    .int()
    .positive()
    .optional()
    .default(3)
    .describe("Maximum depth for recursive listing"),
});

function buildTree(
  dir: string,
  depth: number,
  maxDepth: number,
  recursive: boolean,
): string[] {
  if (depth > maxDepth) return ["  ".repeat(depth - 1) + "..."];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    if (["node_modules", ".git", "dist", ".next", "__pycache__"].includes(entry.name)) {
      lines.push("  ".repeat(depth) + `${entry.name}/ (skipped)`);
      continue;
    }
    const indent = "  ".repeat(depth);
    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`);
      if (recursive) {
        const subDir = path.join(dir, entry.name);
        lines.push(...buildTree(subDir, depth + 1, maxDepth, recursive));
      }
    } else {
      const stat = fs.statSync(path.join(dir, entry.name));
      const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
      lines.push(`${indent}${entry.name} (${size})`);
    }
  }
  return lines;
}

export const listDirTool: ToolDefinition<typeof schema> = {
  name: "list_dir",
  description:
    "List the contents of a directory. Shows files and subdirectories with sizes. Use recursive=true for a full tree view.",
  parameters: schema,
  permissionLevel: "read",
  async execute({ path: dirPath, recursive = false, max_depth = 3 }) {
    const targetPath = dirPath ? jailPath(dirPath) : getProjectRoot();

    if (!fs.existsSync(targetPath)) {
      return { error: `Directory not found: ${dirPath ?? "."}` };
    }

    if (!fs.statSync(targetPath).isDirectory()) {
      return { error: `${dirPath} is a file, not a directory` };
    }

    const lines = buildTree(targetPath, 0, max_depth, recursive);
    const display = (dirPath ?? ".") + "/\n" + lines.join("\n");
    return { tree: display };
  },
};

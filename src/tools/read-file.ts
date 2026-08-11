import * as fs from "fs";
import { z } from "zod";
import { jailPath } from "../sandbox/path-jail.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  path: z.string().describe("Path to the file to read, relative to the project root"),
  start_line: z.number().int().positive().optional().describe("Start line (1-indexed, inclusive)"),
  end_line: z.number().int().positive().optional().describe("End line (1-indexed, inclusive)"),
});

export const readFileTool: ToolDefinition<typeof schema> = {
  name: "read_file",
  description:
    "Read the contents of a file. Optionally specify start_line and end_line to read a specific range. Returns the file content as a string.",
  parameters: schema,
  permissionLevel: "read",
  async execute({ path: filePath, start_line, end_line }) {
    const absPath = jailPath(filePath);

    if (!fs.existsSync(absPath)) {
      return { error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      return { error: `${filePath} is a directory. Use list_dir to explore directories.` };
    }

    let content = fs.readFileSync(absPath, "utf8");

    if (start_line !== undefined || end_line !== undefined) {
      const lines = content.split("\n");
      const from = (start_line ?? 1) - 1;
      const to = end_line ?? lines.length;
      content = lines.slice(from, to).join("\n");
    }

    return { content, path: filePath };
  },
};

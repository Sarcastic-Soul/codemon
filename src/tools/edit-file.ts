import * as fs from "fs";
import { z } from "zod";
import { jailPath } from "../sandbox/path-jail.ts";
import { applyEdit } from "../utils/diff-apply.ts";
import { dbSaveCheckpoint } from "../storage/checkpoints.repo.ts";
import { getSession } from "../core/session.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  path: z.string().describe("Path to the file to edit, relative to the project root"),
  old_str: z
    .string()
    .describe(
      "The exact string to find and replace. Must uniquely identify the location in the file.",
    ),
  new_str: z.string().describe("The replacement string"),
});

export const editFileTool: ToolDefinition<typeof schema> = {
  name: "edit_file",
  description:
    "Make a targeted edit to a file by replacing old_str with new_str. Uses fuzzy matching to handle minor whitespace drift. The old_str should be specific enough to uniquely identify the location.",
  parameters: schema,
  permissionLevel: "write",
  async execute({ path: filePath, old_str, new_str }) {
    const absPath = jailPath(filePath);

    if (!fs.existsSync(absPath)) {
      return { error: `File not found: ${filePath}` };
    }

    const originalContent = fs.readFileSync(absPath, "utf8");

    // Checkpoint before any edit (idempotent — only saves the first per file per session)
    try {
      const session = getSession();
      dbSaveCheckpoint(session.id, absPath, originalContent, "edit_file");
    } catch {}

    const result = applyEdit(originalContent, old_str, new_str);
    if (!result.success) return { error: result.error };

    fs.writeFileSync(absPath, result.newContent, "utf8");
    return { success: true, path: filePath, diff: result.unified };
  },
};

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { jailPath } from "../sandbox/path-jail.ts";
import { dbSaveCheckpoint } from "../storage/checkpoints.repo.ts";
import { getSession } from "../core/session.ts";
import type { ToolDefinition } from "./types.ts";

const schema = z.object({
  path: z.string().describe("Path to the file to write, relative to the project root"),
  content: z.string().describe("Full content to write to the file"),
});

export const writeFileTool: ToolDefinition<typeof schema> = {
  name: "write_file",
  description:
    "Create a new file or completely overwrite an existing file with the given content. Use edit_file for targeted edits to preserve existing content.",
  parameters: schema,
  permissionLevel: "write",
  async execute({ path: filePath, content }) {
    const absPath = jailPath(filePath);
    const dir = path.dirname(absPath);

    // Checkpoint original content before overwriting
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      try {
        const original = fs.readFileSync(absPath, "utf8");
        const session = getSession();
        dbSaveCheckpoint(session.id, absPath, original, "write_file");
      } catch {}
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
    return { success: true, path: filePath, bytes: content.length };
  },
};

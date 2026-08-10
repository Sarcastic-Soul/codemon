import * as fs from "fs";
import * as path from "path";

const GUIDE_FILENAMES = ["codemon.md", "CODEMON.md", "codemon.MD"];

/**
 * Reads the Trainer's Guide (codemon.md) from the project root.
 * Returns its content to be injected into the system prompt, or null if not found.
 */
export function loadTrainerGuide(projectRoot: string = process.cwd()): string | null {
  for (const filename of GUIDE_FILENAMES) {
    const filePath = path.join(projectRoot, filename);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) {
          return `## Project Trainer's Guide (from codemon.md)\n\n${content}`;
        }
      } catch {}
    }
  }
  return null;
}

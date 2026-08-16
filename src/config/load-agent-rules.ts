import * as fs from "fs";
import * as path from "path";

const RULES_FILENAMES = ["codemon.md", "CODEMON.md", "codemon.MD"];

/**
 * Reads codemon.md from the project root, returning it for injection into the
 * system prompt, or null if absent.
 */
export function loadAgentRules(projectRoot: string = process.cwd()): string | null {
  for (const filename of RULES_FILENAMES) {
    const filePath = path.join(projectRoot, filename);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) {
          return `## Project Agent Rules (from codemon.md)\n\n${content}`;
        }
      } catch {}
    }
  }
  return null;
}

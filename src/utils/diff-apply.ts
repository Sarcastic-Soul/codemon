/**
 * Fuzzy string replacement for edit_file.
 * Handles minor whitespace/indent drift that models sometimes produce.
 */
import * as diffLib from "diff";

export interface ApplyResult {
  success: boolean;
  newContent: string;
  unified?: string;
  error?: string;
}

/**
 * Normalize whitespace for fuzzy matching — collapse runs of spaces/tabs.
 */
function normalize(s: string): string {
  return s.replace(/[ \t]+/g, " ").trim();
}

/**
 * Find the best matching block of lines in `haystack` for `needle`,
 * using normalized comparison. Returns the start line index (0-based) or -1.
 */
function findBestMatch(haystackLines: string[], needleLines: string[]): number {
  const normalNeedle = needleLines.map(normalize);
  const windowSize = needleLines.length;

  let bestScore = -1;
  let bestIdx = -1;

  for (let i = 0; i <= haystackLines.length - windowSize; i++) {
    const window = haystackLines.slice(i, i + windowSize).map(normalize);
    let matches = 0;
    for (let j = 0; j < windowSize; j++) {
      if (window[j] === normalNeedle[j]) matches++;
    }
    const score = matches / windowSize;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // Require at least 70% similarity for fuzzy match
  return bestScore >= 0.7 ? bestIdx : -1;
}

export function applyEdit(
  originalContent: string,
  oldStr: string,
  newStr: string,
): ApplyResult {
  // 1. Exact match first
  if (originalContent.includes(oldStr)) {
    const newContent = originalContent.replace(oldStr, newStr);
    const unified = diffLib.createPatch("file", originalContent, newContent, "", "");
    return { success: true, newContent, unified };
  }

  // 2. Fuzzy line-based match
  const haystackLines = originalContent.split("\n");
  const needleLines = oldStr.split("\n");
  const matchIdx = findBestMatch(haystackLines, needleLines);

  if (matchIdx === -1) {
    return {
      success: false,
      newContent: originalContent,
      error: `Could not find target block in file. The old_str may not match the file content.`,
    };
  }

  const newLines = [
    ...haystackLines.slice(0, matchIdx),
    ...newStr.split("\n"),
    ...haystackLines.slice(matchIdx + needleLines.length),
  ];
  const newContent = newLines.join("\n");
  const unified = diffLib.createPatch("file", originalContent, newContent, "", "");
  return { success: true, newContent, unified };
}

/**
 * Parse a unified diff string into colored lines for display.
 */
export function parseDiffLines(unified: string): Array<{ type: "add" | "remove" | "context" | "header"; line: string }> {
  return unified.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      return { type: "header" as const, line };
    }
    if (line.startsWith("+")) return { type: "add" as const, line };
    if (line.startsWith("-")) return { type: "remove" as const, line };
    return { type: "context" as const, line };
  });
}

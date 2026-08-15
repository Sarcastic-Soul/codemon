/**
 * String replacement for edit_file.
 *
 * Two strategies, tried in order: an exact match, then a line-based fuzzy match
 * that tolerates the whitespace and indent drift models produce. Neither one
 * guesses — when more than one place in the file fits, the edit is refused
 * rather than applied to the first of them. An edit that lands on the wrong
 * block looks exactly like one that landed correctly from the outside, so
 * ambiguity has to be an error rather than a coin flip.
 */
import * as diffLib from "diff";

export type ApplyStrategy = "exact" | "fuzzy";

export interface ApplyResult {
  success: boolean;
  newContent: string;
  unified?: string;
  error?: string;
  /** Which strategy produced the edit. Absent on failure. */
  strategy?: ApplyStrategy;
  /** Fuzzy matches only: the fraction of lines that matched, 0–1. */
  similarity?: number;
}

/**
 * Minimum share of normalized lines a block must match to be edited.
 *
 * Normalization already absorbs whitespace drift, which is the only difference
 * this path exists to forgive — anything below the threshold differs in content
 * the model named wrongly. At the old 0.7, three lines in ten could be text the
 * model never mentioned and still get overwritten wholesale.
 */
const MIN_SIMILARITY = 0.9;

/** A disjoint block scoring within this of the winner makes the choice a toss-up. */
const AMBIGUITY_MARGIN = 0.05;

/**
 * Normalize whitespace for fuzzy matching — collapse runs of spaces/tabs.
 */
function normalize(s: string): string {
  return s.replace(/[ \t]+/g, " ").trim();
}

function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

type FuzzyMatch =
  | { kind: "match"; index: number; score: number }
  | { kind: "ambiguous"; index: number; rival: number; score: number }
  | { kind: "none"; bestScore: number };

/**
 * Score every window of `needleLines.length` lines in the haystack and pick the
 * best one, refusing if a second, non-overlapping block scores nearly as well.
 */
function findBestMatch(haystackLines: string[], needleLines: string[]): FuzzyMatch {
  const needle = needleLines.map(normalize);
  // Normalized once here rather than once per window — the old version
  // re-normalized every line as many times as the window was wide.
  const haystack = haystackLines.map(normalize);
  const size = needle.length;

  if (size === 0 || haystack.length < size) return { kind: "none", bestScore: 0 };

  const scores: number[] = [];
  for (let i = 0; i + size <= haystack.length; i++) {
    let hits = 0;
    for (let j = 0; j < size; j++) {
      if (haystack[i + j] === needle[j]) hits++;
    }
    scores.push(hits / size);
  }

  let best = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i]! > scores[best]!) best = i;
  }
  const bestScore = scores[best]!;

  if (bestScore < MIN_SIMILARITY) return { kind: "none", bestScore };

  // Windows overlapping the winner are the same region seen through a shifted
  // frame, not a second candidate — only a disjoint block counts as a rival.
  let rival = -1;
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(i - best) < size) continue;
    if (scores[i]! < bestScore - AMBIGUITY_MARGIN) continue;
    if (rival === -1 || scores[i]! > scores[rival]!) rival = i;
  }
  if (rival !== -1) return { kind: "ambiguous", index: best, rival, score: bestScore };

  return { kind: "match", index: best, score: bestScore };
}

export function applyEdit(
  originalContent: string,
  oldStr: string,
  newStr: string,
): ApplyResult {
  const fail = (error: string): ApplyResult => ({
    success: false,
    newContent: originalContent,
    error,
  });

  const succeed = (
    newContent: string,
    strategy: ApplyStrategy,
    similarity?: number,
  ): ApplyResult => ({
    success: true,
    newContent,
    unified: diffLib.createPatch("file", originalContent, newContent, "", ""),
    strategy,
    ...(similarity === undefined ? {} : { similarity }),
  });

  if (oldStr === "") {
    return fail(
      "old_str is empty, which matches everywhere. Give the exact text to replace, " +
        "or use write_file to replace the whole file.",
    );
  }
  if (oldStr === newStr) {
    return fail("old_str and new_str are identical — this edit would change nothing.");
  }

  // 1. Exact match — but only when the file contains exactly one of them.
  const occurrences = countOccurrences(originalContent, oldStr);
  if (occurrences > 1) {
    return fail(
      `old_str occurs ${occurrences} times in the file, so this edit is ambiguous. ` +
        `Include enough surrounding context to identify exactly one of them.`,
    );
  }
  if (occurrences === 1) {
    const at = originalContent.indexOf(oldStr);
    // Spliced rather than String.replace: there, `$&` and `$'` in the
    // replacement are substitution patterns, and new_str is arbitrary code.
    const newContent =
      originalContent.slice(0, at) + newStr + originalContent.slice(at + oldStr.length);
    return succeed(newContent, "exact");
  }

  // 2. Fuzzy line-based match.
  const haystackLines = originalContent.split("\n");
  const needleLines = oldStr.split("\n");
  const match = findBestMatch(haystackLines, needleLines);

  if (match.kind === "none") {
    const closest =
      match.bestScore > 0
        ? ` The closest block matched ${percent(match.bestScore)} of its lines, under the ${percent(MIN_SIMILARITY)} threshold.`
        : "";
    return fail(
      `Could not find the target block in the file.${closest} Re-read the file and copy old_str from it.`,
    );
  }

  if (match.kind === "ambiguous") {
    return fail(
      `old_str matches two separate blocks about equally well — at lines ` +
        `${match.index + 1} and ${match.rival + 1}, both around ${percent(match.score)}. ` +
        `Include enough surrounding context to identify exactly one of them.`,
    );
  }

  const newLines = [
    ...haystackLines.slice(0, match.index),
    ...newStr.split("\n"),
    ...haystackLines.slice(match.index + needleLines.length),
  ];
  return succeed(newLines.join("\n"), "fuzzy", match.score);
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

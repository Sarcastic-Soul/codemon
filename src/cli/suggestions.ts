/**
 * Autocomplete for the prompt: `/` for slash commands, `@` to reference a file
 * or folder.
 *
 * Pure on purpose — the trigger detection and the text splice are the parts
 * that are easy to get subtly wrong (a `@` mid-word, a second `@` in the same
 * message, an already-complete path), so they are testable without a terminal.
 */
import { ALL_COMMANDS } from "./commands/index.ts";

export type SuggestionKind = "command" | "file";

export interface Suggestion {
  /** Text spliced into the input, without the trigger character. */
  value: string;
  /** What the popup shows. */
  label: string;
  /** Dimmed trailing text — a description, or a directory marker. */
  detail?: string;
  kind: SuggestionKind;
}

export interface CompletionQuery {
  kind: SuggestionKind;
  /** Text typed after the trigger character. */
  term: string;
  /** Index of the trigger character within the input. */
  start: number;
}

/** Rows of suggestions on screen at once. */
export const MAX_SUGGESTIONS = 6;

/**
 * What the input is currently asking to complete, or null.
 *
 * `/` only counts as a command trigger at the very start and before any space:
 * once the command is typed the rest is arguments, and a `/` inside a path
 * (`src/cli`) must never open the command list. `@` counts anywhere a token
 * starts, so a file can be referenced mid-sentence.
 */
export function detectCompletion(input: string): CompletionQuery | null {
  if (input.startsWith("/") && !/\s/.test(input)) {
    return { kind: "command", term: input.slice(1), start: 0 };
  }

  // Scan the final whitespace-delimited token; anything earlier is settled text.
  const lastSpace = Math.max(input.lastIndexOf(" "), input.lastIndexOf("\n"));
  const tokenStart = lastSpace + 1;
  const token = input.slice(tokenStart);

  if (token.startsWith("@")) {
    return { kind: "file", term: token.slice(1), start: tokenStart };
  }

  return null;
}

/**
 * Splice an accepted suggestion into the input, replacing the token being
 * completed. Directories keep the cursor adjacent so the next path segment can
 * be typed straight away; anything else gets a trailing space.
 */
export function applyCompletion(
  input: string,
  query: CompletionQuery,
  suggestion: Suggestion,
): string {
  const trigger = query.kind === "command" ? "/" : "@";
  const head = input.slice(0, query.start);
  const tail = input.slice(query.start + 1 + query.term.length);
  const isDirectory = suggestion.kind === "file" && suggestion.value.endsWith("/");
  const separator = isDirectory ? "" : " ";

  return `${head}${trigger}${suggestion.value}${separator}${tail.trimStart()}`;
}

/** Slash commands as suggestions, canonical name first. */
export function commandSuggestions(): Suggestion[] {
  return ALL_COMMANDS.map((cmd) => ({
    value: cmd.names[0]!.replace(/^\//, ""),
    label: cmd.names[0]!,
    detail: cmd.description,
    kind: "command" as const,
  }));
}

/**
 * Rank candidates against what has been typed.
 *
 * A prefix match beats a substring match beats a subsequence match, so typing
 * `app` puts `app.tsx` above `src/cli/app.tsx` above `a-p-p`. Ties break on the
 * shorter candidate, which is almost always the one meant.
 */
export function rankSuggestions(
  candidates: Suggestion[],
  term: string,
  limit: number = MAX_SUGGESTIONS,
): Suggestion[] {
  if (term === "") return candidates.slice(0, limit);

  const needle = term.toLowerCase();
  const scored: Array<{ suggestion: Suggestion; score: number }> = [];

  for (const suggestion of candidates) {
    const hay = suggestion.value.toLowerCase();
    const base = hay.split("/").pop() ?? hay;

    let score: number;
    if (base.startsWith(needle)) score = 0;
    else if (hay.startsWith(needle)) score = 1;
    else if (base.includes(needle)) score = 2;
    else if (hay.includes(needle)) score = 3;
    else if (isSubsequence(needle, hay)) score = 4;
    else continue;

    scored.push({ suggestion, score });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.suggestion.value.length - b.suggestion.value.length)
    .slice(0, limit)
    .map((s) => s.suggestion);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * Rewrite `@path` mentions into something the model can act on.
 *
 * The model has no idea what an `@` means, so left alone the mention reads as
 * noise. Turning it into a plain backticked path keeps the sentence readable and
 * points the file tools straight at it.
 */
export function expandMentions(input: string): string {
  return input.replace(/(^|\s)@([^\s]+)/g, (_match, lead: string, target: string) => {
    return `${lead}\`${target}\``;
  });
}

/** Every `@`-mentioned path in a message, in order, deduped. */
export function mentionedPaths(input: string): string[] {
  const found = [...input.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]!);
  return [...new Set(found)];
}

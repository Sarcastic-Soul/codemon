/**
 * Just enough Markdown for the transcript: bold, inline code, headings, bullets,
 * quotes and fenced code blocks.
 *
 * Models answer in Markdown whether asked to or not, and printed raw it reads as
 * `**noise**`. This stays one output line per input line, and every transform
 * only removes characters, so a rendered line is never wider than the source
 * line `estimateMessageRows` measured — the transcript's row budget still holds.
 */

export interface Span {
  text: string;
  bold?: boolean;
  code?: boolean;
}

export type LineKind = "text" | "heading" | "bullet" | "quote" | "code" | "fence";

export interface MdLine {
  kind: LineKind;
  spans: Span[];
}

const INLINE = /(\*\*[^*\n]+?\*\*|`[^`\n]+`)/g;

/** Split a line into plain, bold and code spans. Unclosed markers stay literal. */
export function parseInline(line: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index!;
    if (at > last) spans.push({ text: line.slice(last, at) });
    if (token.startsWith("**")) spans.push({ text: token.slice(2, -2), bold: true });
    else spans.push({ text: token.slice(1, -1), code: true });
    last = at + token.length;
  }
  if (last < line.length) spans.push({ text: line.slice(last) });
  return spans;
}

export function parseMarkdown(content: string): MdLine[] {
  let inFence = false;

  return content.split("\n").map((line): MdLine => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      // The language tag is worth keeping as a label; the backticks are not.
      return { kind: "fence", spans: [{ text: line.trim().slice(3).trim() }] };
    }
    if (inFence) return { kind: "code", spans: [{ text: line }] };

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return { kind: "heading", spans: parseInline(heading[1]!) };

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      return { kind: "bullet", spans: [{ text: `${bullet[1]}• ` }, ...parseInline(bullet[2]!)] };
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) return { kind: "quote", spans: [{ text: "│ " }, ...parseInline(quote[1]!)] };

    return { kind: "text", spans: parseInline(line) };
  });
}

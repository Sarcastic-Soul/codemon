import { describe, test, expect } from "bun:test";
import { parseInline, parseMarkdown } from "./markdown.ts";

const text = (line: { spans: { text: string }[] }) => line.spans.map((s) => s.text).join("");

describe("parseInline", () => {
  test("bold and inline code lose their markers", () => {
    expect(parseInline("run **this** with `bun test` now")).toEqual([
      { text: "run " },
      { text: "this", bold: true },
      { text: " with " },
      { text: "bun test", code: true },
      { text: " now" },
    ]);
  });

  test("an unclosed marker is left as typed", () => {
    expect(parseInline("2 ** 3 and a ` tick")).toEqual([{ text: "2 ** 3 and a ` tick" }]);
  });

  test("a plain line is one span", () => {
    expect(parseInline("hello")).toEqual([{ text: "hello" }]);
  });
});

describe("parseMarkdown", () => {
  test("keeps one output line per input line", () => {
    const source = "# Title\n\n- one\n- two\n```ts\nconst x = 1;\n```\n> quoted";
    expect(parseMarkdown(source)).toHaveLength(source.split("\n").length);
  });

  test("classifies headings, bullets, quotes and fenced code", () => {
    const kinds = parseMarkdown("# Title\n- item\n> quote\n```ts\nconst x = 1;\n```\nplain").map(
      (l) => l.kind,
    );
    expect(kinds).toEqual(["heading", "bullet", "quote", "fence", "code", "fence", "text"]);
  });

  test("markdown inside a code block is left alone", () => {
    const [, code] = parseMarkdown("```\n**not bold** # not a heading\n```");
    expect(code!.kind).toBe("code");
    expect(text(code!)).toBe("**not bold** # not a heading");
  });

  test("a fence keeps its language as a label", () => {
    expect(text(parseMarkdown("```python")[0]!)).toBe("python");
  });

  test("no rendered line is wider than its source", () => {
    // estimateMessageRows measures the raw text; rendering wider would break
    // the transcript's row budget.
    const source = "## **Big** title\n  * nested `code` item\n> a **quote**\n1. numbered\n```\n  indented\n```";
    const raw = source.split("\n");
    parseMarkdown(source).forEach((line, i) => {
      expect(text(line).length).toBeLessThanOrEqual(raw[i]!.length);
    });
  });
});

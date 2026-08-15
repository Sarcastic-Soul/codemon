import { describe, test, expect } from "bun:test";
import { applyEdit, type ApplyStrategy } from "./diff-apply.ts";

/**
 * `applyEdit` used to take any block scoring 70% on normalized line equality
 * and overwrite the whole window, and to reach for `String.replace` on the
 * exact path — which silently takes the first of N occurrences. Both report
 * `success: true`, so an edit landing on the wrong lines is indistinguishable
 * from one landing on the right ones. These cases pin down that anything
 * ambiguous now comes back as an error instead of an edit.
 */

interface Success {
  ok: true;
  strategy: ApplyStrategy;
  content: string;
  similarity?: number;
}

interface Failure {
  ok: false;
  error: RegExp;
}

interface Case {
  name: string;
  file: string;
  oldStr: string;
  newStr: string;
  want: Success | Failure;
}

/** A block that appears twice in `TWINS`, byte for byte. */
const TWIN_BLOCK = "function twin() {\n  return 1;\n}";
const TWINS = `${TWIN_BLOCK}\n\nconst middle = true;\n\n${TWIN_BLOCK}\n`;

/** The same block twice, differing only in whitespace — so no exact match. */
const SPACED_TWINS = [
  "function a() {",
  "  const x = 1;",
  "  return x;",
  "}",
  "",
  "function b() {",
  "  const  x  =  1;",
  "  return  x;",
  "}",
  "",
].join("\n");

/** Ten lines, of which a near-miss needle can get seven right. */
const TEN_LINES = [
  "export function compute(input) {",
  "  const scaled = input * 2;",
  "  const offset = scaled + 10;",
  "  if (offset > 100) {",
  "    return 100;",
  "  }",
  "  if (offset < 0) {",
  "    return 0;",
  "  }",
  "  return offset;",
  "}",
  "",
].join("\n");

const cases: Case[] = [
  {
    name: "exact · replaces a unique occurrence",
    file: "const a = 1;\nconst b = 2;\n",
    oldStr: "const b = 2;",
    newStr: "const b = 3;",
    want: { ok: true, strategy: "exact", content: "const a = 1;\nconst b = 3;\n" },
  },
  {
    name: "exact · treats `$&` in new_str as literal text",
    // String.replace reads `$&` as "the matched text"; splicing does not.
    file: "const label = OLD;\n",
    oldStr: "OLD",
    newStr: "$& + $` + NEW",
    want: { ok: true, strategy: "exact", content: "const label = $& + $` + NEW;\n" },
  },
  {
    name: "exact · replaces a multi-line block identified by unique context",
    file: TWINS,
    oldStr: `const middle = true;`,
    newStr: `const middle = false;`,
    want: {
      ok: true,
      strategy: "exact",
      content: `${TWIN_BLOCK}\n\nconst middle = false;\n\n${TWIN_BLOCK}\n`,
    },
  },
  {
    name: "ambiguous · refuses a block that occurs twice",
    file: TWINS,
    oldStr: TWIN_BLOCK,
    newStr: "function twin() {\n  return 2;\n}",
    want: { ok: false, error: /occurs 2 times/i },
  },
  {
    name: "fuzzy · applies through whitespace drift",
    file: "function a() {\n  const x = 1;\n  return x;\n}\n",
    oldStr: "const   x = 1;\n\treturn x;",
    newStr: "  const x = 2;\n  return x;",
    want: {
      ok: true,
      strategy: "fuzzy",
      similarity: 1,
      content: "function a() {\n  const x = 2;\n  return x;\n}\n",
    },
  },
  {
    name: "ambiguous · refuses two blocks that fuzzy-match equally well",
    file: SPACED_TWINS,
    oldStr: "const  x = 1;\nreturn   x;",
    newStr: "const x = 42;\nreturn x;",
    want: { ok: false, error: /two separate blocks/i },
  },
  {
    name: "no match · refuses a block that is only 70% right",
    file: TEN_LINES,
    oldStr: [
      "export function compute(input) {",
      "  const scaled = input * 2;",
      "  const offset = scaled + 10;",
      "  if (offset > 999) {", // ← wrong
      "    return 999;", //      ← wrong
      "  }",
      "  if (offset < 0) {",
      "    return 0;",
      "  }",
      "  logResult(offset);", // ← wrong
    ].join("\n"),
    newStr: "// replaced",
    want: { ok: false, error: /closest block matched 70%/i },
  },
  {
    name: "no match · refuses text that is not in the file at all",
    file: "const a = 1;\n",
    oldStr: "class Something {\n  method() {}\n}",
    newStr: "// replaced",
    want: { ok: false, error: /could not find the target block/i },
  },
  {
    name: "no match · refuses an empty old_str instead of prepending",
    file: "const a = 1;\n",
    oldStr: "",
    newStr: "// injected",
    want: { ok: false, error: /old_str is empty/i },
  },
  {
    name: "no match · refuses an edit that would change nothing",
    file: "const a = 1;\n",
    oldStr: "const a = 1;",
    newStr: "const a = 1;",
    want: { ok: false, error: /identical/i },
  },
];

describe("applyEdit", () => {
  for (const c of cases) {
    test(c.name, () => {
      const result = applyEdit(c.file, c.oldStr, c.newStr);

      if (!c.want.ok) {
        expect(result.success).toBe(false);
        expect(result.error).toMatch(c.want.error);
        // A refused edit must leave the caller with the original content —
        // edit_file writes `newContent` back regardless of what it inspects.
        expect(result.newContent).toBe(c.file);
        return;
      }

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.newContent).toBe(c.want.content);
      expect(result.strategy).toBe(c.want.strategy);
      expect(result.unified).toContain("@@");
      if (c.want.similarity !== undefined) {
        expect(result.similarity).toBeCloseTo(c.want.similarity, 5);
      }
    });
  }

  test("reports fuzzy applications so the caller can flag them", () => {
    const file = "a\n  const b = 1;\n";
    const exact = applyEdit(file, "const b = 1;", "const b = 2;");
    // Two spaces mid-line, so there is no substring to find — only a fuzzy one.
    const fuzzy = applyEdit(file, "const  b = 1;", "const b = 2;");

    expect(exact.strategy).toBe("exact");
    expect(exact.similarity).toBeUndefined();
    expect(fuzzy.strategy).toBe("fuzzy");
    expect(fuzzy.similarity).toBe(1);
  });

  test("a near-miss the old threshold would have applied is refused", () => {
    // Exactly the failure this stage is about: 7 of 10 lines matched, three
    // lines the model never named rewritten, reported as a success.
    const result = applyEdit(TEN_LINES, cases[6]!.oldStr, "// replaced");
    expect(result.success).toBe(false);
    expect(result.newContent).toBe(TEN_LINES);
  });
});

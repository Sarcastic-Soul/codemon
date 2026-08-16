import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  detectCompletion,
  applyCompletion,
  rankSuggestions,
  commandSuggestions,
  expandMentions,
  mentionedPaths,
  type Suggestion,
} from "./suggestions.ts";
import { buildFileIndex, resetFileIndex } from "./file-index.ts";
import { estimateMessageRows, fitMessages, type Message } from "./components/ChatView.tsx";

const file = (value: string): Suggestion => ({ value, label: value, kind: "file" });

describe("detectCompletion", () => {
  test("a leading slash opens the command list", () => {
    expect(detectCompletion("/")).toEqual({ kind: "command", term: "", start: 0 });
    expect(detectCompletion("/conn")).toEqual({ kind: "command", term: "conn", start: 0 });
  });

  test("a slash inside a path is not a command trigger", () => {
    // The whole point of the no-whitespace rule: `src/cli` must stay text.
    expect(detectCompletion("look at src/cli")).toBeNull();
    expect(detectCompletion("/connector google")).toBeNull(); // arguments, not a name
  });

  test("@ completes the token it starts, anywhere in the line", () => {
    expect(detectCompletion("@")).toEqual({ kind: "file", term: "", start: 0 });
    expect(detectCompletion("explain @src/cli/app")).toEqual({
      kind: "file",
      term: "src/cli/app",
      start: 8,
    });
  });

  test("an @ in the middle of a word is left alone", () => {
    expect(detectCompletion("mail me@example.com")).toBeNull();
  });

  test("only the final token is completed", () => {
    // An earlier mention is settled text; completing it would rewrite history.
    const query = detectCompletion("diff @a.ts against @b.ts")!;
    expect(query.term).toBe("b.ts");
    expect(query.start).toBe(19);
  });

  test("plain prose completes nothing", () => {
    expect(detectCompletion("")).toBeNull();
    expect(detectCompletion("hello there")).toBeNull();
  });
});

describe("applyCompletion", () => {
  test("replaces the token being completed, keeping the rest of the line", () => {
    const input = "explain @src/cl";
    const query = detectCompletion(input)!;
    expect(applyCompletion(input, query, file("src/cli/app.tsx"))).toBe("explain @src/cli/app.tsx ");
  });

  test("a directory keeps the cursor attached so the path can continue", () => {
    const input = "@src";
    const query = detectCompletion(input)!;
    expect(applyCompletion(input, query, file("src/cli/"))).toBe("@src/cli/");
  });

  test("a command completion leaves a space for arguments", () => {
    const input = "/conn";
    const query = detectCompletion(input)!;
    const [connector] = rankSuggestions(commandSuggestions(), "conn", 1);
    expect(applyCompletion(input, query, connector!)).toBe("/connector ");
  });

  test("text after the completed token survives", () => {
    const input = "compare @a.ts";
    const query = detectCompletion(input)!;
    expect(applyCompletion(input, query, file("src/a.ts"))).toBe("compare @src/a.ts ");
  });
});

describe("rankSuggestions", () => {
  const pool = [file("src/cli/app.tsx"), file("app.tsx"), file("src/a-p-p.ts"), file("readme.md")];

  test("basename prefix beats path prefix beats subsequence", () => {
    const ranked = rankSuggestions(pool, "app").map((s) => s.value);
    expect(ranked[0]).toBe("app.tsx");
    expect(ranked).toContain("src/cli/app.tsx");
    expect(ranked.indexOf("src/cli/app.tsx")).toBeLessThan(ranked.indexOf("src/a-p-p.ts"));
  });

  test("non-matches are dropped, not just sorted lower", () => {
    expect(rankSuggestions(pool, "app").map((s) => s.value)).not.toContain("readme.md");
  });

  test("an empty term returns the head of the pool", () => {
    expect(rankSuggestions(pool, "", 2)).toHaveLength(2);
  });

  test("the limit is honoured", () => {
    expect(rankSuggestions(pool, "a", 2)).toHaveLength(2);
  });
});

describe("mentions", () => {
  test("an @path becomes a plain reference the model can act on", () => {
    // Left as `@src/app.ts` the model reads it as noise; backticked it is a path.
    expect(expandMentions("explain @src/app.ts please")).toBe("explain `src/app.ts` please");
  });

  test("an email address is not a mention", () => {
    expect(expandMentions("mail me@example.com")).toBe("mail me@example.com");
  });

  test("every mention is collected, deduped, in order", () => {
    expect(mentionedPaths("diff @a.ts and @b.ts and @a.ts")).toEqual(["a.ts", "b.ts"]);
    expect(mentionedPaths("no mentions here")).toEqual([]);
  });
});

describe("buildFileIndex", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetFileIndex();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  test("lists project files and the directories implied by them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-idx-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, "src", "cli"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "cli", "app.tsx"), "x");
    fs.writeFileSync(path.join(root, "readme.md"), "x");

    const values = buildFileIndex(root).map((s) => s.value);

    expect(values).toContain("src/cli/app.tsx");
    expect(values).toContain("readme.md");
    // Directories are completable too, so `@src/` can be narrowed first.
    expect(values).toContain("src/");
    expect(values).toContain("src/cli/");
  });

  test("node_modules is pruned rather than enumerated", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-idx-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "x");
    fs.writeFileSync(path.join(root, "main.ts"), "x");

    const values = buildFileIndex(root).map((s) => s.value);

    expect(values).toContain("main.ts");
    expect(values.some((v) => v.includes("node_modules"))).toBe(false);
  });
});

describe("transcript fits the terminal", () => {
  const msg = (content: string): Message => ({ role: "assistant", content });

  test("a wrapped line costs more than one row", () => {
    const narrow = estimateMessageRows(msg("x".repeat(300)), 40);
    const wide = estimateMessageRows(msg("x".repeat(300)), 200);
    expect(narrow).toBeGreaterThan(wide);
  });

  test("only what fits is rendered", () => {
    // Counting messages instead of rows is what let the transcript overflow and
    // push the prompt off the bottom of the screen.
    const history = Array.from({ length: 40 }, () => msg("line\n".repeat(5)));
    const { visible } = fitMessages(history, 30, 80);

    const used = visible.reduce((n, m) => n + estimateMessageRows(m, 80) + 1, 0);
    expect(used).toBeLessThanOrEqual(30);
    expect(visible.length).toBeLessThan(history.length);
  });

  test("the newest message is kept even when it alone overflows", () => {
    // Dropping it would blank the screen exactly when there is something to read.
    const { visible } = fitMessages([msg("y".repeat(10_000))], 5, 80);
    expect(visible).toHaveLength(1);
  });

  test("a short history is shown whole", () => {
    const history = [msg("hi"), msg("there")];
    expect(fitMessages(history, 100, 80).visible).toEqual(history);
    expect(fitMessages(history, 100, 80).hidden).toBe(0);
  });

  test("an empty history is not a special case", () => {
    expect(fitMessages([], 20, 80)).toEqual({ visible: [], hidden: 0, start: 0 });
  });
});

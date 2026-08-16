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
import { suggestionWindow } from "./components/SuggestionPopup.tsx";
import { tailLines } from "./components/ReasoningView.tsx";
import { buildTips } from "./components/ThinkingIndicator.tsx";
import { ALL_COMMANDS } from "./commands/index.ts";
import { estimateMessageRows, fitMessages, maxScrollOffset, type Message } from "./components/ChatView.tsx";
import { diffFromResult as diffFromResultSync } from "./app.tsx";
import { diffViewRows, DIFF_MAX_LINES } from "./components/DiffView.tsx";
import { bannerVariant } from "./components/Banner.tsx";
import { FALLBACK_SIZE } from "./hooks/use-terminal-size.ts";

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
    expect(fitMessages([], 20, 80)).toEqual({ visible: [], hidden: 0, start: 0, newer: 0 });
  });
});

describe("command list completeness", () => {
  test("every alias is completable, not just the canonical name", () => {
    // Only emitting canonical names showed 4 entries when 10 exist, and left
    // /q and /model — both of which dispatch — impossible to complete.
    const labels = commandSuggestions().map((s) => s.label);

    expect(labels).toEqual(
      expect.arrayContaining(["/exit", "/quit", "/q", "/connector", "/config", "/model", "/help", "/clear"]),
    );
    expect(labels.length).toBeGreaterThanOrEqual(10);
  });

  test("an alias says what it is an alias of", () => {
    const q = commandSuggestions().find((s) => s.label === "/q")!;
    expect(q.detail).toBe("alias of /exit");
  });

  test("typing a bare slash offers every command, not a truncated few", () => {
    const all = rankSuggestions(commandSuggestions(), "");
    expect(all.length).toBe(commandSuggestions().length);
  });

  test("an alias completes to itself", () => {
    const input = "/q";
    const query = detectCompletion(input)!;
    const [first] = rankSuggestions(commandSuggestions(), "q", 1);
    expect(applyCompletion(input, query, first!)).toBe("/q ");
  });
});

describe("suggestionWindow", () => {
  test("a short list is shown whole, with no scrolling", () => {
    expect(suggestionWindow(3, 0, 5)).toEqual({ offset: 0, size: 3 });
  });

  test("the window follows the cursor down a long list", () => {
    const { offset, size } = suggestionWindow(10, 7, 5);
    expect(size).toBe(5);
    expect(offset).toBeLessThanOrEqual(7);
    expect(offset + size).toBeGreaterThan(7); // cursor stays visible
  });

  test("it never scrolls past either end", () => {
    expect(suggestionWindow(10, 0, 5).offset).toBe(0);
    expect(suggestionWindow(10, 9, 5).offset).toBe(5); // last full page
  });

  test("the cursor is visible at every position", () => {
    for (let i = 0; i < 10; i++) {
      const { offset, size } = suggestionWindow(10, i, 5);
      expect(i).toBeGreaterThanOrEqual(offset);
      expect(i).toBeLessThan(offset + size);
    }
  });
});

describe("reasoning view", () => {
  test("keeps only the tail — it is context, not the answer", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const lines = tailLines(text, 4, 80);
    expect(lines).toEqual(["line 16", "line 17", "line 18", "line 19"]);
  });

  test("a long unbroken line is wrapped, not truncated away", () => {
    expect(tailLines("x".repeat(250), 10, 100)).toHaveLength(3);
  });

  test("blank lines do not eat the budget", () => {
    expect(tailLines("a\n\n\nb", 4, 80)).toEqual(["a", "b"]);
  });
});

describe("thinking tips", () => {
  test("are built from the registry, so a new command advertises itself", () => {
    const tips = buildTips();
    expect(tips.some((t) => t.startsWith("/connector"))).toBe(true);
    expect(tips.some((t) => t.includes("@"))).toBe(true);
    expect(tips.length).toBeGreaterThan(ALL_COMMANDS.length);
  });

  test("a command with aliases mentions them", () => {
    expect(buildTips().find((t) => t.startsWith("/exit"))).toContain("also /quit");
  });
});

describe("transcript scrollback", () => {
  const msg = (content: string): Message => ({ role: "assistant", content });
  const history = Array.from({ length: 30 }, (_, i) => msg(`message ${i}`));

  test("offset 0 shows the newest messages", () => {
    // Pinning the layout to the terminal height removed the terminal's own
    // scrollback, so the transcript has to provide it — but the default must
    // still be the live end of the conversation.
    const { visible } = fitMessages(history, 20, 80, 0);
    expect(visible.at(-1)!.content).toBe("message 29");
  });

  test("scrolling back moves the window earlier in the history", () => {
    const { visible } = fitMessages(history, 20, 80, 5);
    expect(visible.at(-1)!.content).toBe("message 24");
  });

  test("scrolling past the start clamps to the first message", () => {
    const { visible, hidden } = fitMessages(history, 20, 80, 999);
    expect(visible[0]!.content).toBe("message 0");
    expect(hidden).toBe(0);
  });

  test("the window still fits the row budget while scrolled", () => {
    const tall = Array.from({ length: 30 }, () => msg("line\n".repeat(4)));
    const { visible } = fitMessages(tall, 24, 80, 6);
    const used = visible.reduce((n, m) => n + estimateMessageRows(m, 80) + 1, 0);
    expect(used).toBeLessThanOrEqual(24);
  });

  test("maxScrollOffset stops one short of scrolling the history away", () => {
    expect(maxScrollOffset(history)).toBe(29);
    expect(maxScrollOffset([])).toBe(0);
    // Never scroll to a blank screen.
    expect(fitMessages(history, 20, 80, maxScrollOffset(history)).visible.length).toBeGreaterThan(0);
  });
});

describe("write_file reports a diff", () => {
  test("the more destructive tool is no longer the invisible one", async () => {
    // edit_file returned a diff and write_file did not, so overwriting a file
    // showed only "done" while a targeted edit rendered its change.
    const { writeFileTool } = await import("../tools/write-file.ts");
    const { setProjectRoot, getProjectRoot } = await import("../sandbox/path-jail.ts");

    const previous = getProjectRoot();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-write-"));
    setProjectRoot(root);

    try {
      const created = (await writeFileTool.execute({ path: "poem.txt", content: "one\ntwo\n" })) as
        Record<string, unknown>;
      expect(created.created).toBe(true);
      expect(String(created.diff)).toContain("+one");

      const overwritten = (await writeFileTool.execute({
        path: "poem.txt",
        content: "one\nthree\n",
      })) as Record<string, unknown>;

      expect(overwritten.created).toBe(false);
      expect(String(overwritten.diff)).toContain("-two");
      expect(String(overwritten.diff)).toContain("+three");
    } finally {
      setProjectRoot(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tool result reaches the diff view", () => {
  test("a write_file result now produces a renderable diff entry", async () => {
    // This is the join that was broken: write_file's result had no `diff`, so
    // diffFromResult returned null and the UI drew nothing for an overwrite.
    const { diffFromResult } = await import("./app.tsx");

    expect(diffFromResult({ success: true, path: "a.txt", bytes: 3 })).toBeNull();
    expect(
      diffFromResult({ success: true, path: "a.txt", bytes: 3, diff: "@@\n+one\n" }),
    ).toEqual({ unified: "@@\n+one\n", path: "a.txt" });
  });

  test("a fuzzy edit_file result keeps its similarity marker", () => {
    expect(
      diffFromResultSync({ path: "a.txt", diff: "@@\n-x\n+y\n", strategy: "fuzzy", similarity: 0.8 }),
    ).toEqual({ unified: "@@\n-x\n+y\n", path: "a.txt", fuzzy: { similarity: 0.8 } });
  });
});

describe("the frame never outgrows the terminal", () => {
  const msg = (content: string): Message => ({ role: "assistant", content });

  test("the estimator agrees with what DiffView actually draws", () => {
    // These two disagreed — 12 rows estimated, 50 drawn. A frame taller than the
    // terminal makes Ink scroll instead of repaint in place, which tiled the
    // side panel down the window.
    const unified = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
    const withDiff: Message = { role: "assistant", content: "done", diffs: [{ unified, path: "a.txt" }] };

    const estimated = estimateMessageRows(withDiff, 80);
    const drawn = 1 + 1 + diffViewRows(unified); // header + body line + the diff

    expect(estimated).toBe(drawn);
  });

  test("a diff is bounded no matter how large the change", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    expect(diffViewRows(huge)).toBeLessThan(20);
    expect(diffViewRows(huge, DIFF_MAX_LINES)).toBe(diffViewRows(huge));
  });

  test("a short diff is not padded to the cap", () => {
    expect(diffViewRows("+one\n-two")).toBeLessThan(diffViewRows("+one\n".repeat(30)));
  });

  test("a transcript of huge diffs still fits its row budget", () => {
    const unified = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join("\n");
    const history: Message[] = Array.from({ length: 12 }, () => ({
      role: "assistant",
      content: "wrote the file",
      diffs: [{ unified, path: "a.txt" }],
    }));

    const { visible } = fitMessages(history, 30, 80);
    const used = visible.reduce((n, m) => n + estimateMessageRows(m, 80) + 1, 0);

    // The newest message is always kept whole, so allow for exactly that one
    // overshooting; everything beyond it must respect the budget.
    expect(used).toBeLessThanOrEqual(30 + estimateMessageRows(history[0]!, 80));
    expect(visible.length).toBeLessThan(history.length);
  });
});

describe("the banner adapts to the window", () => {
  test("a wide terminal gets the pokeball beside the wordmark", () => {
    expect(bannerVariant(30, 120)).toBe("pair");
  });

  test("a narrower one drops the pokeball before it would wrap", () => {
    // A wrapped banner is worse than a smaller one: it is the first thing drawn
    // and would push the prompt off a short screen.
    expect(bannerVariant(30, 70)).toBe("wordmark");
  });

  test("too narrow for the wordmark falls back to one line", () => {
    expect(bannerVariant(30, 50)).toBe("line");
  });

  test("a short terminal uses one line however wide it is", () => {
    expect(bannerVariant(8, 200)).toBe("line");
  });

  test("the thresholds are ordered, so shrinking only ever simplifies", () => {
    const rank = { pair: 2, wordmark: 1, line: 0 };
    let previous = rank[bannerVariant(30, 200)];
    for (let width = 200; width >= 20; width -= 5) {
      const current = rank[bannerVariant(30, width)];
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("terminal size fallback", () => {
  test("a pipe with no reported size still gets a usable layout", () => {
    // stdout.columns/rows are undefined when output is not a TTY; a zero here
    // would collapse the whole layout.
    expect(FALLBACK_SIZE.columns).toBeGreaterThan(0);
    expect(FALLBACK_SIZE.rows).toBeGreaterThan(0);
  });
});

import { describe, test, expect } from "bun:test";
import { windowMessages, DEFAULT_MAX_VISIBLE, type Message } from "./components/ChatView.tsx";
import { contextMeter } from "./components/SidePanel.tsx";
import { diffFromResult, messageForTurn } from "./app.tsx";
import type { ToolCallEntry } from "./components/ToolCallView.tsx";
import { ALL_COMMANDS } from "./commands/index.ts";
import { USAGE } from "./parse-args.ts";
import { ContextManager } from "../core/context-manager.ts";
import { DEFAULTS, effectiveContextTokens } from "../config/defaults.ts";
import type { ModelMessage } from "../providers/types.ts";

/**
 * With no test renderer here, what is asserted is the logic the render reads:
 * transcript windowing, what the token meter measures, and whether the help
 * surfaces still agree with the command registry.
 */

function transcript(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${i + 1}`,
  }));
}

describe("transcript windowing", () => {
  // ChatView used to map every message in the session, and every message every
  // one of its lines, on each keystroke — the input box lives in the same tree.
  test("a 200-message session renders a bounded number of messages", () => {
    const { visible, hidden } = windowMessages(transcript(200));

    expect(visible).toHaveLength(DEFAULT_MAX_VISIBLE);
    expect(hidden).toBe(200 - DEFAULT_MAX_VISIBLE);
  });

  test("the window holds the newest messages", () => {
    const { visible } = windowMessages(transcript(200), 3);
    expect(visible.map((m) => m.content)).toEqual(["message 198", "message 199", "message 200"]);
  });

  test("a short history is shown whole, with nothing elided", () => {
    const { visible, hidden, start } = windowMessages(transcript(4), 12);

    expect(visible).toHaveLength(4);
    expect(hidden).toBe(0);
    expect(start).toBe(0);
  });

  test("keys stay stable as the history grows", () => {
    // Keys are `start + i`. If they were window-relative, every new message
    // would shift them and remount every row in the window.
    const before = windowMessages(transcript(20), 5);
    const after = windowMessages(transcript(21), 5);

    const keyOf = (w: typeof before, content: string) =>
      w.start + w.visible.findIndex((m) => m.content === content);

    expect(keyOf(before, "message 20")).toBe(19);
    expect(keyOf(after, "message 20")).toBe(19);
  });

  test("an empty history windows to nothing rather than throwing", () => {
    expect(windowMessages([], 12)).toEqual({ visible: [], hidden: 0, start: 0, newer: 0 });
  });
});

describe("token meter", () => {
  test("reads the configured budget rather than a hardcoded 100k", () => {
    // The old bar divided by a literal 100_000 no matter what the model's
    // window was.
    const small = contextMeter(50_000, 100_000);
    const large = contextMeter(50_000, 1_000_000);

    expect(small.percentUsed).toBe(50);
    expect(large.percentUsed).toBe(5);
  });

  test("colors track the thresholds the context manager acts on", () => {
    // Green below the 60% the trim targets, yellow between, red at the 80%
    // that triggers it.
    expect(contextMeter(50, 100).color).toBe("green");
    expect(contextMeter(60, 100).color).toBe("yellow");
    expect(contextMeter(80, 100).color).toBe("red");
  });

  test("the bar fills in proportion and never overflows", () => {
    expect(contextMeter(0, 100, 10).bar).toBe("░".repeat(10));
    expect(contextMeter(50, 100, 10).bar).toBe("█".repeat(5) + "░".repeat(5));
    expect(contextMeter(999, 100, 10).bar).toBe("█".repeat(10));
    expect(contextMeter(999, 100).percentUsed).toBe(100);
  });

  test("a zero or missing budget does not divide by zero", () => {
    expect(contextMeter(1000, 0).percentUsed).toBe(100);
    expect(Number.isFinite(contextMeter(0, 0).percentUsed)).toBe(true);
  });

  test("the meter's own number is what the context manager measures", () => {
    // The meter is fed `estimatedTokens` from the loop's `context` event, which
    // is `getStats` on the messages actually sent. Same input, same figure.
    // A real budget, not DEFAULTS.maxContextTokens — that is now the `0` "size
    // it to the model" sentinel, and would make both sides divide by zero and
    // agree on nothing.
    const budget = effectiveContextTokens(DEFAULTS);
    expect(budget).toBeGreaterThan(0);

    const manager = new ContextManager(budget);
    const messages: ModelMessage[] = [
      { role: "user", content: "x".repeat(4000) },
      { role: "assistant", content: "y".repeat(4000) },
    ];
    const stats = manager.getStats(messages, "system prompt");

    expect(contextMeter(stats.estimatedTokens, budget).percentUsed).toBe(
      Math.min(100, stats.percentUsed),
    );
  });
});

describe("turn history", () => {
  const call = (id: string): ToolCallEntry => ({
    id,
    toolName: "read_file",
    args: { path: "a.ts" },
    status: "success",
  });
  const diff = { unified: "@@ -1 +1 @@", path: "a.ts" };

  // Tool calls and diffs used to sit in state that the next submit cleared, so
  // the record of a turn vanished the moment you replied to it.
  test("a turn's tool calls and diffs travel with its message", () => {
    const message = messageForTurn("done", [call("1"), call("2")], [diff]);

    expect(message?.content).toBe("done");
    expect(message?.toolCalls).toHaveLength(2);
    expect(message?.diffs).toEqual([diff]);
  });

  test("a turn that only ran tools still produces a message", () => {
    const message = messageForTurn("", [call("1")], []);

    expect(message).not.toBeNull();
    expect(message?.toolCalls).toHaveLength(1);
  });

  test("a turn that did nothing produces no message", () => {
    expect(messageForTurn("", [], [])).toBeNull();
  });

  test("a plain reply carries no empty attachment arrays", () => {
    const message = messageForTurn("just text", [], []);

    expect(message?.toolCalls).toBeUndefined();
    expect(message?.diffs).toBeUndefined();
  });
});

describe("diff extraction", () => {
  test("reads a diff out of an edit result", () => {
    expect(diffFromResult({ success: true, path: "a.ts", diff: "@@ -1 +1 @@" })).toEqual({
      unified: "@@ -1 +1 @@",
      path: "a.ts",
    });
  });

  test("flags a fuzzy application so the diff view can mark it", () => {
    const entry = diffFromResult({
      path: "a.ts",
      diff: "@@ -1 +1 @@",
      strategy: "fuzzy",
      similarity: 0.95,
    });

    expect(entry?.fuzzy).toEqual({ similarity: 0.95 });
  });

  test("an exact application is not flagged", () => {
    const entry = diffFromResult({ path: "a.ts", diff: "@@", strategy: "exact" });
    expect(entry?.fuzzy).toBeUndefined();
  });

  test("results without a diff are ignored", () => {
    expect(diffFromResult({ content: "file body", path: "a.ts" })).toBeNull();
    expect(diffFromResult({ error: "File not found: a.ts" })).toBeNull();
    expect(diffFromResult(null)).toBeNull();
    expect(diffFromResult("done")).toBeNull();
  });
});

describe("help surfaces", () => {
  // A hand-written list in `--help` left several TUI commands undocumented.
  test("--help lists every registered command and alias", () => {
    for (const cmd of ALL_COMMANDS) {
      for (const alias of cmd.names) {
        expect(USAGE).toContain(alias);
      }
      expect(USAGE).toContain(cmd.description);
    }
  });

  test("every command carries a side-panel hint", () => {
    // The panel has ~15 columns for it, so the full description will not do.
    for (const cmd of ALL_COMMANDS) {
      expect(cmd.hint.length).toBeGreaterThan(0);
      expect(cmd.hint.length).toBeLessThanOrEqual(15);
    }
  });

  test("no two commands claim the same alias", () => {
    const all = ALL_COMMANDS.flatMap((c) => c.names);
    expect(new Set(all).size).toBe(all.length);
  });
});

import { describe, test, expect } from "bun:test";
import { ContextManager } from "./context-manager.ts";
import type { ModelMessage } from "../providers/types.ts";

describe("ContextManager", () => {
  test("calculates stats correctly", () => {
    const cm = new ContextManager(1000);
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const stats = cm.getStats(messages, "system prompt");
    expect(stats.messageCount).toBe(2);
    expect(stats.estimatedTokens).toBeGreaterThan(0);
    expect(stats.percentUsed).toBeLessThan(80);
  });

  test("does not truncate when under 80% limit", () => {
    const cm = new ContextManager(100000);
    const messages: ModelMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    }));
    const result = cm.maybeTruncate(messages, "short prompt");
    expect(result.length).toBe(30);
  });

  test("truncates to last 20 messages when token limit exceeds 80%", () => {
    const cm = new ContextManager(500); // Very low limit to trigger > 80%
    const messages: ModelMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Very long message contents string number ${i} with lots of text to inflate token count`,
    }));

    const result = cm.maybeTruncate(messages, "system prompt");
    expect(result.length).toBe(20);
    expect(result[result.length - 1]?.content).toContain("number 29");
  });
});

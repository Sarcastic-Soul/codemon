import { describe, test, expect } from "bun:test";
import { ContextManager } from "./context-manager.ts";
import type { ModelMessage } from "../providers/types.ts";

function toolCall(id: string, n: number): ModelMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `Looking into request ${n}.` },
      { type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: `file-${id}.ts` } },
    ],
  } as unknown as ModelMessage;
}

function toolResult(id: string): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value: `contents of ${id}` } },
    ],
  } as unknown as ModelMessage;
}

/**
 * One turn of an agentic exchange: the user's request, then whatever answering
 * it took. Turns are deliberately uneven — some need two tool rounds, some need
 * none — because a real history is, and a fixed-count trim only orphans a
 * tool-call when the boundary doesn't happen to line up with a turn.
 */
function turn(n: number): ModelMessage[] {
  const user: ModelMessage = {
    role: "user",
    content: `Request number ${n} — please look something up for me.`,
  };
  const answer: ModelMessage = {
    role: "assistant",
    content: `Here is what request ${n} turned up, in a reasonably long answer.`,
  };

  if (n % 3 === 2) return [user, answer]; // answered without tools

  const rounds = n % 3 === 0 ? 2 : 1;
  const middle = Array.from({ length: rounds }, (_, r) => {
    const id = `call-${n}-${r}`;
    return [toolCall(id, n), toolResult(id)];
  }).flat();

  return [user, ...middle, answer];
}

function history(turns: number): ModelMessage[] {
  return Array.from({ length: turns }, (_, i) => turn(i)).flat();
}

/** Every tool-call id in the history, and every tool-result id. */
function toolIds(messages: ModelMessage[]): { calls: string[]; results: string[] } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type: string; toolCallId?: string }>) {
      if (part.type === "tool-call" && part.toolCallId) calls.push(part.toolCallId);
      if (part.type === "tool-result" && part.toolCallId) results.push(part.toolCallId);
    }
  }
  return { calls, results };
}

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

  test("truncates when the history crosses 80% of the budget", () => {
    const cm = new ContextManager(2000);
    const messages = history(200);

    const result = cm.maybeTruncate(messages, "system prompt");
    expect(result.length).toBeLessThan(messages.length);
    expect(cm.getStats(result, "system prompt").percentUsed).toBeLessThan(80);
  });

  test("a 200-turn history keeps every tool-call paired with its result", () => {
    // The bug this pins down: `slice(-20)` can cut between an assistant message
    // carrying tool-call parts and the tool message carrying their results.
    // Anthropic and OpenAI both reject that shape, so the session works fine
    // until it crosses the threshold and then every request 400s.
    const cm = new ContextManager(2000);
    const result = cm.maybeTruncate(history(200), "system prompt");

    const { calls, results } = toolIds(result);
    expect(calls.length).toBeGreaterThan(0);
    expect(results).toEqual(calls);
  });

  test("truncated history still starts on a user message", () => {
    const cm = new ContextManager(2000);
    const result = cm.maybeTruncate(history(200), "system prompt");
    expect(result[0]?.role).toBe("user");
  });

  test("keeps whole turns, so the newest exchange is never half-dropped", () => {
    const cm = new ContextManager(2000);
    const messages = history(200);
    const result = cm.maybeTruncate(messages, "system prompt");

    // The tail is untouched, and the cut sits exactly on a turn start.
    expect(result[result.length - 1]?.content).toContain("request 199");
    expect(messages.slice(messages.length - result.length)).toEqual(result);
    expect(result[0]?.content).toContain("Request number");
  });

  test("the newest turn survives even when it alone exceeds the budget", () => {
    const cm = new ContextManager(10); // smaller than any single message
    const result = cm.maybeTruncate(history(3), "system prompt");

    expect(result[0]?.content).toContain("Request number 2");
    expect(toolIds(result).results).toEqual(toolIds(result).calls);
  });

  test("a history with no user message is left alone rather than cut mid-turn", () => {
    const cm = new ContextManager(10);
    const messages = history(3).filter((m) => m.role !== "user");

    // There is no boundary to cut on. An oversized history still round-trips;
    // one sliced between a call and its result does not.
    expect(cm.maybeTruncate(messages, "system prompt")).toEqual(messages);
  });
});

import { describe, test, expect } from "bun:test";
import { applyCompaction, compactHistory, maybeCompact, SUMMARY_PREFIX } from "./compaction.ts";
import { createInMemoryStore } from "./message-store.ts";
import { ContextManager } from "./context-manager.ts";
import { runAgentWithStore } from "./agent-loop.ts";
import { DEFAULTS, type CodemonConfig } from "../config/defaults.ts";
import type { ModelMessage, Provider, StreamEvent } from "../providers/types.ts";

function config(overrides: Partial<CodemonConfig> = {}): CodemonConfig {
  return { ...DEFAULTS, repoIndex: false, permissionMode: "yolo", ...overrides };
}

/** Records what it was asked to summarise, and answers with a fixed string. */
function summariser(text = "SUMMARY") {
  const seen: string[] = [];
  const provider: Provider = {
    streamMessage({ messages }) {
      seen.push(
        messages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n"),
      );
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text", text };
        yield { type: "finish", finishReason: "stop" };
      })();
    },
  };
  return { provider, seen };
}

/** A provider whose stream dies — the fallback path. */
const brokenProvider: Provider = {
  streamMessage() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "error", error: new Error("upstream is down") };
    })();
  },
};

/** Long enough to blow past the 80% trigger on a small budget. */
function bulkyHistory(turns = 20): ModelMessage[] {
  return Array.from({ length: turns * 2 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i} ${"x".repeat(400)}`,
  })) as ModelMessage[];
}

describe("compactHistory", () => {
  test("returns the model's summary", async () => {
    const { provider } = summariser("the goal was X");
    const result = await compactHistory(
      [{ role: "user", content: "do X" }],
      provider,
      config(),
    );
    expect(result).toBe("the goal was X");
  });

  test("a failed summariser returns null rather than throwing", async () => {
    const result = await compactHistory([{ role: "user", content: "do X" }], brokenProvider, config());
    expect(result).toBeNull();
  });

  test("an empty answer is treated as a failure", async () => {
    const { provider } = summariser("   ");
    const result = await compactHistory([{ role: "user", content: "do X" }], provider, config());
    expect(result).toBeNull();
  });

  test("the extra instruction reaches the summariser", async () => {
    const { provider, seen } = summariser();
    await compactHistory([{ role: "user", content: "do X" }], provider, config(), {
      instruction: "focus on the auth refactor",
    });
    expect(seen[0]).toContain("focus on the auth refactor");
  });
});

describe("maybeCompact", () => {
  const manager = () => new ContextManager(2000);

  test("an oversized history is summarised and recorded", async () => {
    const store = createInMemoryStore(bulkyHistory());
    const { provider } = summariser();

    const outcome = await maybeCompact(store, manager(), "system", provider, config());

    expect(outcome.compacted).toBe(true);
    expect(outcome.droppedMessages).toBeGreaterThan(0);
    expect(store.getCompaction()?.summary).toBe("SUMMARY");
  });

  test("the store is never rewritten — only the sent slice shrinks", async () => {
    const history = bulkyHistory();
    const store = createInMemoryStore(history);
    const { provider } = summariser();

    await maybeCompact(store, manager(), "system", provider, config());

    // --rewind and --audit read message rows; losing them here would break both.
    expect(store.getMessages()).toHaveLength(history.length);
  });

  test("a history under the threshold is left alone", async () => {
    const store = createInMemoryStore([{ role: "user", content: "hi" }]);
    const { provider, seen } = summariser();

    const outcome = await maybeCompact(store, manager(), "system", provider, config());

    expect(outcome.compacted).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("force compacts a small history anyway — that is what /compact is", async () => {
    const store = createInMemoryStore([
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ]);
    const { provider } = summariser();

    const outcome = await maybeCompact(store, manager(), "system", provider, config(), { force: true });

    expect(outcome.compacted).toBe(true);
    expect(store.getCompaction()).not.toBeNull();
  });

  test("a failed summariser leaves no record, so the caller falls back to truncation", async () => {
    const store = createInMemoryStore(bulkyHistory());

    const outcome = await maybeCompact(store, manager(), "system", brokenProvider, config());

    expect(outcome.compacted).toBe(false);
    expect(outcome.reason).toBe("summariser failed");
    expect(store.getCompaction()).toBeNull();
  });

  test("summaries compose: the second call is given the first summary", async () => {
    const store = createInMemoryStore(bulkyHistory(10));
    const first = summariser("FIRST SUMMARY");
    await maybeCompact(store, manager(), "system", first.provider, config(), { force: true });

    // More history arrives, then it fills up again.
    for (const msg of bulkyHistory(10)) store.addMessage(msg);

    const second = summariser("SECOND SUMMARY");
    const outcome = await maybeCompact(store, manager(), "system", second.provider, config(), { force: true });

    expect(outcome.compacted).toBe(true);
    expect(second.seen[0]).toContain("FIRST SUMMARY");
    expect(store.getCompaction()?.summary).toBe("SECOND SUMMARY");
  });

  test("already-summarised turns are not summarised twice", async () => {
    const store = createInMemoryStore(bulkyHistory(10));
    const { provider } = summariser();
    await maybeCompact(store, manager(), "system", provider, config(), { force: true });

    const again = summariser();
    const outcome = await maybeCompact(store, manager(), "system", again.provider, config(), { force: true });

    expect(outcome.compacted).toBe(false);
    expect(again.seen).toHaveLength(0);
  });
});

describe("applyCompaction", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ];

  test("with no cut and no summary, the history is returned untouched", () => {
    expect(applyCompaction(history, 0, null)).toEqual(history);
  });

  test("a stored summary still cuts even when the manager planned no cut", () => {
    // This is what makes /compact mean anything: it forces a summary at a point
    // the 80% threshold had not reached, so the next turn plans keepFrom 0.
    // Resending the summarised turns would hand the freed context back.
    const sent = applyCompaction(history, 0, { summary: "S", throughSeq: 1 });

    expect(sent).toHaveLength(2);
    expect(sent[0]!.content).toContain(SUMMARY_PREFIX);
    expect(sent[1]!.content).toBe("three");
  });

  test("the further-back of the two cuts wins", () => {
    // A summary covering less than the plan must not un-trim the plan's cut.
    const sent = applyCompaction(history, 2, { summary: "S", throughSeq: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.content).toBe("three");
  });

  test("the summary is prepended to the kept slice", () => {
    const sent = applyCompaction(history, 2, { summary: "S", throughSeq: 1 });

    expect(sent).toHaveLength(2);
    expect(sent[0]!.content).toContain(SUMMARY_PREFIX);
    expect(sent[0]!.content).toContain("S");
    expect(sent[1]!.content).toBe("three");
  });

  test("the summary rides as a user message, not a system one", () => {
    // The system slot already holds the real prompt, and several providers
    // accept only one.
    const sent = applyCompaction(history, 2, { summary: "S", throughSeq: 1 });
    expect(sent[0]!.role).toBe("user");
  });

  test("a cut with no summary still truncates — the documented fallback", () => {
    const sent = applyCompaction(history, 2, null);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toBe("three");
  });
});

describe("compaction in the agent loop", () => {
  /** Summarises when asked, then replies "ok" to the real turn. */
  function providerFor(): Provider {
    let call = 0;
    return {
      streamMessage() {
        const text = call++ === 0 ? "SUMMARY OF EARLIER WORK" : "ok";
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text", text };
          yield { type: "finish", finishReason: "stop" };
        })();
      },
    };
  }

  test("an oversized history emits a compaction event and the turn completes", async () => {
    const store = createInMemoryStore(bulkyHistory());
    const events: string[] = [];
    let dropped = 0;

    for await (const event of runAgentWithStore(
      "go",
      providerFor(),
      config({ maxContextTokens: 2000 }),
      "system",
      store,
    )) {
      events.push(event.type);
      if (event.type === "compaction") dropped = event.droppedMessages;
    }

    expect(events).toContain("compaction");
    expect(dropped).toBeGreaterThan(0);
    expect(store.getCompaction()?.summary).toBe("SUMMARY OF EARLIER WORK");
  });

  test("a dead summariser does not fail the turn", async () => {
    // The invariant that matters most: compaction is an optimisation, and an
    // optimisation that can take down a turn is a bug.
    let call = 0;
    const provider: Provider = {
      streamMessage() {
        const isSummary = call++ === 0;
        return (async function* (): AsyncGenerator<StreamEvent> {
          if (isSummary) {
            yield { type: "error", error: new Error("summariser down") };
            return;
          }
          yield { type: "text", text: "answered anyway" };
          yield { type: "finish", finishReason: "stop" };
        })();
      },
    };

    const store = createInMemoryStore(bulkyHistory());
    let text = "";
    let sawCompaction = false;

    for await (const event of runAgentWithStore(
      "go",
      provider,
      config({ maxContextTokens: 2000 }),
      "system",
      store,
    )) {
      if (event.type === "text") text += event.text;
      if (event.type === "compaction") sawCompaction = true;
    }

    expect(sawCompaction).toBe(false);
    expect(text).toBe("answered anyway");
  });
});

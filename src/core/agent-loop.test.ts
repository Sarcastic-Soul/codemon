import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runToCompletion, runAgentWithStore, createInMemoryStore } from "./agent-loop.ts";
import { ContextManager } from "./context-manager.ts";
import { AVAILABLE_TOOLS } from "../tools/spawn-subagent.ts";
import { DEFAULTS, type CodemonConfig } from "../config/defaults.ts";
import { setProjectRoot, getProjectRoot } from "../sandbox/path-jail.ts";
import type { Provider, StreamEvent, ModelMessage } from "../providers/types.ts";

/**
 * A provider that replays a fixed script instead of calling a model: one array
 * of events per turn of the agent loop.
 */
function scriptedProvider(turns: StreamEvent[][]): Provider {
  let turn = 0;
  return {
    streamMessage() {
      const events = turns[turn++] ?? [{ type: "finish", finishReason: "stop" }];
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

/** Calls `toolName` once, then ends the turn with plain text. */
function callsTool(toolName: string, args: Record<string, unknown> = {}): Provider {
  return scriptedProvider([
    [
      { type: "tool-call", toolCallId: "call-1", toolName, toolArgs: args },
      { type: "finish", finishReason: "tool-calls" },
    ],
    [{ type: "text", text: "done" }, { type: "finish", finishReason: "stop" }],
  ]);
}

/** Never stops asking for tools — the shape a retry spiral takes. */
function alwaysCallsTool(toolName: string, args: Record<string, unknown> = {}): Provider {
  let n = 0;
  return {
    streamMessage() {
      const toolCallId = `call-${n++}`;
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "tool-call", toolCallId, toolName, toolArgs: args };
        yield { type: "finish", finishReason: "tool-calls" };
      })();
    },
  };
}

function config(overrides: Partial<CodemonConfig> = {}): CodemonConfig {
  return { ...DEFAULTS, repoIndex: false, ...overrides };
}

/** Tool-call parts left in the history with no result to answer them. */
function toolCallIds(messages: ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type: string; toolCallId?: string }>) {
      if (part.type === "tool-call" && part.toolCallId) ids.push(part.toolCallId);
    }
  }
  return ids;
}

const run = (provider: Provider, cfg: CodemonConfig, filter?: Set<string>) =>
  runToCompletion("go", provider, cfg, "system", createInMemoryStore(), filter);

describe("tool filter enforcement", () => {
  test("the sub-agent toolset excludes spawn_subagent", () => {
    // This omission is the entire depth-1 cap; assert it directly rather than
    // trusting a copy of the list.
    expect(AVAILABLE_TOOLS).not.toContain("spawn_subagent");
  });

  test("a tool call outside the filter is refused instead of executed", async () => {
    // The filter used to shape only what the model was offered. A sub-agent
    // that emitted the name anyway got the tool, and each nesting level was
    // another agent.
    const result = await run(
      callsTool("spawn_subagent", { task: "recurse" }),
      config({ permissionMode: "yolo" }),
      new Set<string>(AVAILABLE_TOOLS),
    );

    expect(result.errors.some((e) => e.includes("not available to this agent"))).toBe(true);
  });

  test("a tool call inside the filter is not refused", async () => {
    const result = await run(
      callsTool("read_file", { path: "definitely-not-here.txt" }),
      config({ permissionMode: "yolo" }),
      new Set(["read_file"]),
    );

    // It fails for its own reasons — the point is that the filter let it reach
    // the tool at all.
    expect(result.toolsUsed).toContain("read_file");
    expect(result.errors.some((e) => e.includes("not available to this agent"))).toBe(false);
  });

  test("with no filter, any registered tool is reachable", async () => {
    const result = await run(
      callsTool("read_file", { path: "definitely-not-here.txt" }),
      config({ permissionMode: "yolo" }),
    );

    expect(result.errors.some((e) => e.includes("not available to this agent"))).toBe(false);
  });

  test("an unregistered tool name still reports as unknown", async () => {
    const result = await run(callsTool("no_such_tool"), config({ permissionMode: "yolo" }));
    expect(result.errors.some((e) => e.includes("Unknown tool"))).toBe(true);
  });
});

describe("headless permission handling", () => {
  test("a confirmation request is denied rather than awaited forever", async () => {
    // `bash` needs confirmation in safe mode. runToCompletion has no UI to ask
    // through, and the loop awaits a promise only the prompt's resolve settles
    // — so this used to hang with no timeout. If it regresses, this test times
    // out rather than failing.
    const result = await run(
      callsTool("bash", { command: "echo hi" }),
      config({ permissionMode: "safe" }),
    );

    expect(result.errors.some((e) => e.includes("denied"))).toBe(true);
    expect(result.errors.some((e) => e.includes("safe"))).toBe(true);
    expect(result.output).toBe("done");
  });

  test("yolo still runs bash without a prompt", async () => {
    const result = await run(
      callsTool("bash", { command: "echo hi" }),
      config({ permissionMode: "yolo" }),
    );

    expect(result.errors.some((e) => e.includes("denied"))).toBe(false);
  });

  test("safe mode still auto-allows read-level tools", async () => {
    const result = await run(
      callsTool("read_file", { path: "definitely-not-here.txt" }),
      config({ permissionMode: "safe" }),
    );

    expect(result.errors.some((e) => e.includes("denied"))).toBe(false);
  });
});

describe("turn budget", () => {
  // A model that keeps calling tools used to run until the process was killed,
  // burning tokens on every turn.
  const spinner = () => alwaysCallsTool("read_file", { path: "definitely-not-here.txt" });

  test("a tool-calling loop stops at the budget", async () => {
    const result = await run(spinner(), config({ permissionMode: "yolo", maxTurns: 3 }));
    expect(result.toolsUsed.length).toBe(3);
  });

  test("stopping is announced rather than silent", async () => {
    const result = await run(spinner(), config({ permissionMode: "yolo", maxTurns: 3 }));

    // The user sees it in the transcript…
    expect(result.output).toContain("Stopped after 3 tool-calling turns");
    // …and a headless caller can detect it without grepping prose.
    expect(result.errors.some((e) => e.includes("Turn budget exhausted"))).toBe(true);
  });

  test("a budget that would disable the ceiling falls back to the default", async () => {
    // Config files are hand-written, and `maxTurns: 0` must not mean "forever".
    const result = await run(spinner(), config({ permissionMode: "yolo", maxTurns: 0 }));
    expect(result.toolsUsed.length).toBe(DEFAULTS.maxTurns);
  });

  test("a turn that ends in text finishes well inside the budget", async () => {
    const result = await run(
      callsTool("read_file", { path: "definitely-not-here.txt" }),
      config({ permissionMode: "yolo", maxTurns: 25 }),
    );

    expect(result.output).toBe("done");
    expect(result.errors.some((e) => e.includes("Turn budget"))).toBe(false);
  });
});

describe("context reporting", () => {
  /** Every `context` event a run emits, in order. */
  async function contextEvents(
    provider: Provider,
    cfg: CodemonConfig,
    history: ModelMessage[] = [],
  ) {
    const store = createInMemoryStore(history);
    const seen: Array<{ estimatedTokens: number; maxTokens: number; percentUsed: number }> = [];
    for await (const event of runAgentWithStore("go", provider, cfg, "system", store)) {
      if (event.type === "context") seen.push(event);
    }
    return { events: seen, store };
  }

  const replies = () => scriptedProvider([[{ type: "text", text: "ok" }, { type: "finish", finishReason: "stop" }]]);

  test("each turn reports what the context manager measures", async () => {
    // The side panel's meter is fed from this number. If it were computed
    // anywhere else, the bar and the trim would be tracking two quantities —
    // which is exactly the bug in the meter it replaces.
    const cfg = config({ permissionMode: "yolo" });
    const { events, store } = await contextEvents(replies(), cfg);

    expect(events).toHaveLength(1);

    const manager = new ContextManager(cfg.maxContextTokens);
    // The store holds the user message the loop added plus the reply; the event
    // was measured before the reply was saved.
    const sent = store.getMessages().filter((m) => m.role === "user");
    expect(events[0]!.estimatedTokens).toBe(manager.getStats(sent, "system").estimatedTokens);
    expect(events[0]!.maxTokens).toBe(cfg.maxContextTokens);
  });

  test("the reported figure falls when the history is trimmed", async () => {
    // A budget small enough that a big history is over the 80% trigger.
    const cfg = config({ permissionMode: "yolo", maxContextTokens: 2000 });
    const bulky: ModelMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(400),
    })) as ModelMessage[];

    const untrimmed = new ContextManager(cfg.maxContextTokens).getStats(bulky, "system");
    const { events } = await contextEvents(replies(), cfg, bulky);

    expect(untrimmed.percentUsed).toBeGreaterThan(80);
    expect(events[0]!.estimatedTokens).toBeLessThan(untrimmed.estimatedTokens);
  });
});

describe("stream errors", () => {
  const originalRoot = getProjectRoot();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-stream-"));
  const sentinel = path.join(root, "written-by-an-errored-turn.txt");

  afterAll(() => {
    setProjectRoot(originalRoot);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Asks for a write, then the stream dies. A second turn waits behind it. */
  function failsMidTurn(): Provider {
    return scriptedProvider([
      [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "write_file",
          toolArgs: { path: path.basename(sentinel), content: "should never be written" },
        },
        { type: "error", error: new Error("upstream stream closed") },
      ],
      [{ type: "text", text: "second turn" }, { type: "finish", finishReason: "stop" }],
    ]);
  }

  test("an errored turn does not go on to run its tool calls", async () => {
    setProjectRoot(root);
    const store = createInMemoryStore();

    const result = await runToCompletion(
      "go",
      failsMidTurn(),
      config({ permissionMode: "yolo" }),
      "system",
      store,
    );

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(result.errors.some((e) => e.includes("upstream stream closed"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Turn aborted"))).toBe(true);
  });

  test("an errored turn does not start another one", async () => {
    setProjectRoot(root);
    const result = await runToCompletion(
      "go",
      failsMidTurn(),
      config({ permissionMode: "yolo" }),
      "system",
      createInMemoryStore(),
    );

    expect(result.output).not.toContain("second turn");
  });

  test("no unanswered tool-call is left in the history", async () => {
    // Whatever ends the turn, the history has to stay a shape the provider will
    // accept next time: a tool-call with no matching result is rejected.
    setProjectRoot(root);
    const store = createInMemoryStore();

    await runToCompletion("go", failsMidTurn(), config({ permissionMode: "yolo" }), "system", store);

    expect(toolCallIds(store.getMessages())).toEqual([]);
  });
});

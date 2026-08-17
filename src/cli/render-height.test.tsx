/**
 * Do the row estimates match what actually gets drawn?
 *
 * `layout.test.ts` only proves the arithmetic is self-consistent; every
 * whole-screen jump so far came from an estimate disagreeing with the component
 * it estimates (12 rows planned, 50 drawn). So these tests assert no numbers:
 * they render through Ink into a fake terminal, count the lines, and hold the
 * estimator to that.
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import { render, Box } from "ink";
import { EventEmitter } from "events";
import { DiffView, diffViewRows, DIFF_MAX_LINES } from "./components/DiffView.tsx";
import {
  ToolCallView,
  toolCallViewRows,
  type ToolCallEntry,
} from "./components/ToolCallView.tsx";
import { ThinkingIndicator } from "./components/ThinkingIndicator.tsx";
import { ReasoningView } from "./components/ReasoningView.tsx";
import { BANNER_ROWS, ChatView, estimateMessageRows, type Message } from "./components/ChatView.tsx";
import { stripAnsi } from "./debug-frames.ts";

/** A terminal Ink will draw into and that keeps every frame it is handed. */
class FakeTerminal extends EventEmitter {
  isTTY = true;
  frames: string[] = [];
  constructor(public columns: number, public rows: number) {
    super();
  }
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/**
 * Rows a node occupies at `columns` wide.
 *
 * `debug: true` makes Ink write each frame in full rather than as a diff against
 * the last one, so the last frame carrying visible text is the whole picture.
 */
function renderedRows(node: React.ReactElement, columns = 50): number {
  const term = new FakeTerminal(columns, 40);
  const instance = render(<Box width={columns} flexDirection="column">{node}</Box>, {
    stdout: term as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.unmount();

  const painted = term.frames.map(stripAnsi).filter((f) => f.trim() !== "");
  if (painted.length === 0) return 0;
  return painted[painted.length - 1]!.split("\n").length;
}

const diffOf = (lines: string[]) => lines.join("\n");

describe("DiffView draws what diffViewRows promises", () => {
  const cases: Array<[string, string, number?]> = [
    ["a short diff", diffOf(["--- a", "+++ b", "@@ -1 +1 @@", "-old", "+new"])],
    [
      "a diff with lines far wider than the terminal",
      diffOf(["@@ -1 +1 @@", `+${"x".repeat(400)}`, `-${"y".repeat(400)}`]),
    ],
    [
      "a diff longer than the cap",
      diffOf(["@@ -1 +1 @@", ...Array.from({ length: 60 }, (_, i) => `+line ${i}`)]),
    ],
    ["a single-line diff", "+one"],
  ];

  for (const [name, unified, maxLines] of cases) {
    test(name, () => {
      const node = <DiffView unified={unified} filePath="src/some/file.ts" maxLines={maxLines} />;
      expect(renderedRows(node)).toBe(diffViewRows(unified, maxLines ?? DIFF_MAX_LINES));
    });
  }

  test("a long file path does not push the title onto a second line", () => {
    const unified = "+one";
    const long = <DiffView unified={unified} filePath={`src/${"deep/".repeat(40)}file.ts`} />;
    expect(renderedRows(long)).toBe(diffViewRows(unified));
  });

  test("a fuzzy badge stays on the title row", () => {
    const unified = "+one";
    const node = (
      <DiffView unified={unified} filePath="src/x.ts" fuzzy={{ similarity: 0.93 }} />
    );
    expect(renderedRows(node)).toBe(diffViewRows(unified));
  });
});

describe("ToolCallView draws what toolCallViewRows promises", () => {
  const call = (over: Partial<ToolCallEntry>): ToolCallEntry => ({
    id: "1",
    toolName: "read_file",
    args: { path: "src/x.ts" },
    status: "running",
    ...over,
  });

  const cases: Array<[string, ToolCallEntry[]]> = [
    ["nothing at all", []],
    ["one call still running", [call({})]],
    // The regression this file was written for: a finished call draws its own
    // row and a `└ …` row, and the estimate counted one.
    ["one finished call", [call({ status: "success", result: { content: "x\ny" } })]],
    ["one failed call", [call({ status: "error", error: "no such file" })]],
    [
      "a mixed list",
      [
        call({ id: "1", status: "success", result: { content: "x" } }),
        call({ id: "2", status: "error", error: "boom" }),
        call({ id: "3", status: "running" }),
      ],
    ],
    [
      "a call whose argument summary is far wider than the terminal",
      [
        call({
          id: "1",
          toolName: "bash",
          args: { command: "echo ".repeat(80) },
          status: "success",
          result: { stdout: "z".repeat(300), exit_code: 0 },
        }),
      ],
    ],
    [
      "a call whose error message is far wider than the terminal",
      [call({ status: "error", error: "failure: ".repeat(60) })],
    ],
  ];

  for (const [name, calls] of cases) {
    test(name, () => {
      expect(renderedRows(<ToolCallView calls={calls} />)).toBe(toolCallViewRows(calls));
    });
  }
});

describe("the live-turn chrome holds the height the layout reserves for it", () => {
  // These two are reserved as constants in layout.ts rather than measured, so
  // they have to be fixed-height at every width.
  test("the thinking indicator is two rows, whichever tip is showing", () => {
    for (const tipIndex of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const columns of [24, 40, 80, 200]) {
        expect(
          renderedRows(<ThinkingIndicator elapsedSeconds={12} tipIndex={tipIndex} />, columns),
          `tip ${tipIndex} at ${columns} columns`,
        ).toBe(2);
      }
    }
  });

  test("reasoning stays inside its eight reserved rows however much arrives", () => {
    const text = Array.from({ length: 50 }, (_, i) => `step ${i} ${"detail ".repeat(30)}`).join("\n");
    for (const columns of [24, 40, 80, 200]) {
      expect(renderedRows(<ReasoningView text={text} width={columns} />, columns)).toBeLessThanOrEqual(8);
    }
  });
});

describe("the transcript stays inside the rows it is given", () => {
  const user = (n: number): Message => ({ role: "user", content: `question ${n}` });
  const reply = (n: number): Message => ({
    role: "assistant",
    content: `answer ${n}\n${"prose ".repeat(20)}`,
  });

  const history = Array.from({ length: 40 }, (_, i) => (i % 2 ? reply(i) : user(i)));

  const withWork: Message[] = [
    ...history.slice(0, 6),
    {
      role: "assistant",
      content: "done",
      toolCalls: [
        { id: "1", toolName: "read_file", args: { path: "a.ts" }, status: "success", result: { content: "x" } },
        { id: "2", toolName: "edit_file", args: { path: "b.ts" }, status: "success", result: { path: "b.ts" } },
      ],
      diffs: [{ unified: diffOf(["@@ -1 +1 @@", "-a", "+b"]), path: "b.ts" }],
    },
  ];

  // The interesting cases are the ones that used to overflow: a full history
  // (which draws the "↑ earlier" banner), a scrolled-back view (which draws the
  // "↓ newer" one), and a stream arriving on top of either.
  test("across histories, heights, widths, scroll positions and mid-stream", () => {
    for (const messages of [history, withWork, history.slice(0, 1), []]) {
      for (const maxRows of [3, 5, 8, 12, 20, 30]) {
        for (const columns of [40, 60, 100]) {
          for (const scrollOffset of [0, 1, 7]) {
            for (const streamingText of ["", "partial reply", "long ".repeat(60)]) {
              const rows = renderedRows(
                <ChatView
                  messages={messages}
                  streamingText={streamingText}
                  maxRows={maxRows}
                  width={columns}
                  scrollOffset={scrollOffset}
                />,
                columns,
              );

              // Three things are never dropped, whatever the budget: the newest
              // message (blanking the screen exactly when there is something to
              // read would be worse), the reply streaming in, and the scroll
              // banners that say where you are. On a terminal too short to hold
              // them the transcript overruns, and the pane clips it — so the
              // allowance is those three, not an open-ended one.
              const end = Math.max(1, messages.length - scrollOffset);
              const newest = messages[end - 1];
              const newestRows = newest ? estimateMessageRows(newest, columns) + 1 : 0;
              const streamRows = streamingText
                ? estimateMessageRows({ role: "assistant", content: streamingText }, columns)
                : 0;
              const newerRows = scrollOffset > 0 && messages.length > 1 ? BANNER_ROWS : 0;

              const undroppable = newestRows + streamRows + newerRows;
              const allowance =
                undroppable + BANNER_ROWS <= maxRows ? maxRows : undroppable + BANNER_ROWS;

              expect(
                rows,
                `maxRows=${maxRows} columns=${columns} scroll=${scrollOffset} stream=${streamingText.length}`,
              ).toBeLessThanOrEqual(allowance);
            }
          }
        }
      }
    }
  });

  test("the newest message is kept even when it alone overflows", () => {
    const huge: Message[] = [{ role: "assistant", content: "z\n".repeat(200) }];
    // It cannot fit, but blanking the screen when there is something to read
    // would be worse; the overflow is clipped by the pane instead.
    expect(renderedRows(<ChatView messages={huge} maxRows={6} width={60} />, 60)).toBeGreaterThan(0);
  });
});

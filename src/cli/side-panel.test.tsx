/**
 * What the side panel actually paints for the two things it grew: the plan-mode
 * badge and the todo list.
 *
 * Rendered through Ink into a fake terminal, the same approach
 * render-height.test.tsx uses — asserting on the painted text is the only way
 * to catch a badge that is computed correctly and then never drawn.
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import { render, Box } from "ink";
import { EventEmitter } from "events";
import { SidePanel, TODO_VISIBLE_ROWS, visibleTodos } from "./components/SidePanel.tsx";
import { stripAnsi } from "./debug-frames.ts";
import type { Todo } from "../core/todo-store.ts";

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

function paint(node: React.ReactElement, columns = 34): string {
  const term = new FakeTerminal(columns, 40);
  const instance = render(<Box width={columns} flexDirection="column">{node}</Box>, {
    stdout: term as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.unmount();

  const painted = term.frames.map(stripAnsi).filter((f) => f.trim() !== "");
  return painted[painted.length - 1] ?? "";
}

const todo = (content: string, status: Todo["status"]): Todo => ({ content, status });

describe("visibleTodos", () => {
  test("a short list is shown whole", () => {
    const list = [todo("a", "pending"), todo("b", "pending")];
    expect(visibleTodos(list)).toEqual(list);
  });

  test("a long list centres on the item in progress", () => {
    // By item nine the first eight are done and the only interesting row is the
    // current one, so windowing from the top would show nothing useful.
    const list = [
      ...Array.from({ length: 8 }, (_, i) => todo(`done${i}`, "completed")),
      todo("current", "in_progress"),
      ...Array.from({ length: 5 }, (_, i) => todo(`later${i}`, "pending")),
    ];

    const shown = visibleTodos(list);
    expect(shown).toHaveLength(TODO_VISIBLE_ROWS);
    expect(shown.some((t) => t.content === "current")).toBe(true);
  });

  test("with nothing in progress it shows the next pending work", () => {
    const list = [
      ...Array.from({ length: 8 }, (_, i) => todo(`done${i}`, "completed")),
      todo("next", "pending"),
      todo("after", "pending"),
    ];

    expect(visibleTodos(list).some((t) => t.content === "next")).toBe(true);
  });

  test("an all-complete list still shows the tail rather than nothing", () => {
    const list = Array.from({ length: 10 }, (_, i) => todo(`done${i}`, "completed"));
    expect(visibleTodos(list)).toHaveLength(TODO_VISIBLE_ROWS);
  });
});

describe("SidePanel", () => {
  const base = {
    model: "google:gemini-flash-latest",
    region: "/tmp/demo",
    permissionMode: "standard",
    contextTokens: 100,
    maxContextTokens: 1000,
    spentTokens: 50,
    isThinking: false,
    resumed: false,
  };

  test("plan mode is shown as a badge, not as a replacement for the mode", () => {
    const frame = paint(<SidePanel {...base} planMode />);

    expect(frame).toContain("PLAN");
    // The permission mode still governs everything plan mode does not deny.
    expect(frame).toContain("standard");
  });

  test("no badge when plan mode is off", () => {
    expect(paint(<SidePanel {...base} />)).not.toContain("PLAN");
  });

  test("todos render with a completed count", () => {
    const frame = paint(
      <SidePanel
        {...base}
        todos={[todo("read the gate", "completed"), todo("add the branch", "in_progress")]}
      />,
    );

    expect(frame).toContain("todos");
    expect(frame).toContain("1/2");
    expect(frame).toContain("add the branch");
  });

  test("no todo section when the list is empty", () => {
    expect(paint(<SidePanel {...base} todos={[]} />)).not.toContain("todos");
  });

  test("the meters survive a long todo list", () => {
    // Todos are drawn last precisely so a growing list clips itself rather than
    // pushing the context and spend readouts off the panel.
    const frame = paint(
      <SidePanel
        {...base}
        todos={Array.from({ length: 20 }, (_, i) => todo(`step number ${i}`, "pending"))}
      />,
    );

    expect(frame).toContain("context");
    expect(frame).toContain("spent");
  });
});

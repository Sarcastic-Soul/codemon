import { describe, test, expect } from "bun:test";
import { computeLayout, MIN_COLUMNS_FOR_PANEL, SIDE_PANEL_WIDTH, type LayoutInput } from "./layout.ts";

const base: LayoutInput = {
  rows: 40,
  columns: 120,
  inputHidden: false,
  suggestionCount: 0,
  isThinking: false,
  hasReasoning: false,
  toolCallRows: 0,
  diffRows: 0,
};

const at = (overrides: Partial<LayoutInput>) => computeLayout({ ...base, ...overrides });

describe("the frame never exceeds the terminal", () => {
  // One row too many and Ink stops repainting in place and starts scrolling,
  // which is what the whole-screen jump looked like.
  test("across every size and state combination", () => {
    for (let rows = 6; rows <= 60; rows += 2) {
      for (const columns of [30, 60, 80, 120, 200]) {
        for (const isThinking of [false, true]) {
          for (const hasReasoning of [false, true]) {
            for (const suggestionCount of [0, 3, 40]) {
              for (const toolCallRows of [0, 6]) {
                for (const diffRows of [0, 16]) {
                  const layout = at({
                    rows,
                    columns,
                    isThinking,
                    hasReasoning,
                    suggestionCount,
                    toolCallRows,
                    diffRows,
                  });

                  expect(
                    layout.totalRows,
                    `overflowed at rows=${rows} thinking=${isThinking} sugg=${suggestionCount}`,
                  ).toBeLessThanOrEqual(rows);
                }
              }
            }
          }
        }
      }
    }
  });
});

describe("the transcript shares the pane with the live turn", () => {
  test("the thinking indicator takes its rows from the transcript, not from thin air", () => {
    // The bug: the indicator renders *inside* the pane, but ChatView was handed
    // the pane's whole height — so content overflowed by exactly the indicator's
    // two rows, and the overflow disappeared the moment the reply arrived.
    const idle = at({ isThinking: false });
    const busy = at({ isThinking: true });

    expect(busy.paneRows).toBe(idle.paneRows); // the pane itself does not move
    expect(busy.chatRows).toBe(idle.chatRows - 2); // the transcript yields instead
  });

  test("reasoning, tool calls and diffs all come out of the transcript's share", () => {
    const idle = at({});
    expect(at({ hasReasoning: true }).chatRows).toBeLessThan(idle.chatRows);
    expect(at({ toolCallRows: 6 }).chatRows).toBeLessThan(idle.chatRows);
    expect(at({ diffRows: 16 }).chatRows).toBeLessThan(idle.chatRows);
  });

  test("everything drawn inside the pane fits inside the pane", () => {
    const layout = at({ isThinking: true, hasReasoning: true, toolCallRows: 8, diffRows: 10 });
    const inside = 2 + 8 + 8 + 10;
    expect(layout.chatRows + inside).toBeLessThanOrEqual(layout.paneRows);
  });

  test("a busy turn on a small terminal still leaves a row of transcript", () => {
    const layout = at({ rows: 10, isThinking: true, hasReasoning: true, diffRows: 20 });
    expect(layout.chatRows).toBeGreaterThanOrEqual(1);
    expect(layout.totalRows).toBeLessThanOrEqual(10);
  });
});

describe("chrome outside the pane", () => {
  test("the completion popup takes room from the pane, not from the prompt", () => {
    const withPopup = at({ suggestionCount: 5 });
    expect(withPopup.paneRows).toBeLessThan(at({ suggestionCount: 0 }).paneRows);
    expect(withPopup.totalRows).toBeLessThanOrEqual(base.rows);
  });

  test("the popup is capped at its window, however many matches there are", () => {
    expect(at({ suggestionCount: 500 }).paneRows).toBe(at({ suggestionCount: 5 }).paneRows);
  });

  test("hiding the prompt gives its rows back to the pane", () => {
    expect(at({ inputHidden: true }).paneRows).toBe(at({ inputHidden: false }).paneRows + 3);
  });
});

describe("the side panel", () => {
  test("is dropped when it would crowd out the conversation", () => {
    expect(at({ columns: MIN_COLUMNS_FOR_PANEL }).showPanel).toBe(true);
    expect(at({ columns: MIN_COLUMNS_FOR_PANEL - 1 }).showPanel).toBe(false);
  });

  test("its columns come back to the content when it is dropped", () => {
    const wide = at({ columns: 120 });
    expect(wide.contentWidth).toBe(120 - SIDE_PANEL_WIDTH - 2);
    expect(at({ columns: 60 }).contentWidth).toBe(58);
  });

  test("content width never collapses on a very narrow terminal", () => {
    expect(at({ columns: 10 }).contentWidth).toBeGreaterThanOrEqual(20);
  });
});

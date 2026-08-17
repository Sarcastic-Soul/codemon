/**
 * How the main screen is divided up.
 *
 * Pure and separate from the component because getting it wrong is not a
 * cosmetic matter: a frame one row taller than the terminal makes Ink stop
 * repainting in place and start scrolling, which shows up as the whole screen
 * jumping. Every bug of that shape so far has been an arithmetic slip here, so
 * the arithmetic is testable on its own.
 */
import { SUGGESTION_WINDOW } from "./suggestions.ts";

/** Columns reserved for the side panel. */
export const SIDE_PANEL_WIDTH = 34;

/**
 * Below this the side panel is dropped. At 40 columns it was taking 34 of them
 * and leaving the conversation six, which is worse than no panel at all.
 */
export const MIN_COLUMNS_FOR_PANEL = 72;

/** Prompt box: two border rows plus the line itself. */
const INPUT_ROWS = 3;

/** Popup: its rows, two border rows, and the footer hint. */
const POPUP_CHROME = 3;

/** The spinner line plus its tip. */
const THINKING_ROWS = 2;

/** Reasoning header plus `MAX_LINES` of tail, roughly. */
const REASONING_ROWS = 8;


export interface LayoutInput {
  rows: number;
  columns: number;
  /** True while a modal owns the screen and the prompt is not drawn. */
  inputHidden: boolean;
  suggestionCount: number;
  isThinking: boolean;
  hasReasoning: boolean;
  /**
   * Rows the live tool-call list will occupy, from `toolCallViewRows` — not the
   * number of calls. A running call draws one row and a finished one draws two,
   * so a count under-reserves by one row per completed call.
   */
  toolCallRows: number;
  /** Rows the live diffs will occupy, from `diffViewRows`. */
  diffRows: number;
}

export interface Layout {
  showPanel: boolean;
  /** Height of the transcript pane — the box that holds everything scrollable. */
  paneRows: number;
  /**
   * Rows `ChatView` may use *inside* the pane.
   *
   * This is the distinction that was missing: the thinking indicator, reasoning,
   * tool calls and diffs all render inside the pane, so the transcript gets what
   * is left after them — not the pane's full height. Handing ChatView the whole
   * pane made the content overflow by exactly the indicator's two rows, and the
   * overflow vanished the instant the reply arrived. That was the flicker.
   */
  chatRows: number;
  /** Suggestion rows the popup may draw; 0 hides it on a very short terminal. */
  popupVisibleRows: number;
  contentWidth: number;
  /** What the frame will actually occupy. Must never exceed `rows`. */
  totalRows: number;
}

export function computeLayout(input: LayoutInput): Layout {
  const { rows, columns, inputHidden, suggestionCount } = input;

  const inputRows = inputHidden ? 0 : INPUT_ROWS;

  // Priority when space runs out: the prompt always survives, then the popup
  // shrinks, and the transcript gives up the rest. A popup asking for its full
  // window on a six-row terminal is what pushed the frame past the bottom.
  const roomForPopup = Math.max(0, rows - inputRows - 1);
  const popupVisibleRows =
    suggestionCount > 0 && roomForPopup >= POPUP_CHROME + 1
      ? Math.min(Math.min(suggestionCount, SUGGESTION_WINDOW), roomForPopup - POPUP_CHROME)
      : 0;
  const popupRows = popupVisibleRows > 0 ? popupVisibleRows + POPUP_CHROME : 0;

  // Everything that draws inside the pane, below the transcript.
  const insideRows =
    (input.isThinking ? THINKING_ROWS : 0) +
    (input.hasReasoning ? REASONING_ROWS : 0) +
    Math.max(0, input.toolCallRows) +
    Math.max(0, input.diffRows);

  // The pane takes whatever the prompt and popup leave. Never below one row —
  // a zero-height box would collapse the column and take the prompt with it.
  const paneRows = Math.max(1, rows - inputRows - popupRows);
  const chatRows = Math.max(1, paneRows - insideRows);

  const showPanel = columns >= MIN_COLUMNS_FOR_PANEL;
  const contentWidth = Math.max(20, columns - (showPanel ? SIDE_PANEL_WIDTH + 2 : 2));

  return {
    showPanel,
    paneRows,
    chatRows,
    popupVisibleRows,
    contentWidth,
    totalRows: paneRows + inputRows + popupRows,
  };
}

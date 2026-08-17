import React from "react";
import { Box, Text } from "ink";
import { ToolCallView, toolCallViewRows, type ToolCallEntry } from "./ToolCallView.tsx";
import { DiffView, diffViewRows, type DiffEntry } from "./DiffView.tsx";
import { GLYPH } from "../theme.ts";

export interface Message {
  role: "user" | "assistant";
  content: string;
  /** Tool calls the agent made while producing this message. */
  toolCalls?: ToolCallEntry[];
  /** File edits produced during the same turn. */
  diffs?: DiffEntry[];
}

interface ChatViewProps {
  messages: Message[];
  streamingText?: string;
  /** How many messages to render. Older ones collapse to a single line. */
  maxVisible?: number;
  /** Rows the transcript may occupy. Overrides `maxVisible` when given. */
  maxRows?: number;
  /** Terminal width, for estimating how far a message wraps. */
  width?: number;
  /** Messages to step back from the newest. 0 pins the view to the bottom. */
  scrollOffset?: number;
}

/**
 * The transcript has no scrollback, so anything taller than the terminal is
 * unreachable anyway. Windowing keeps re-layout cost flat as a session grows.
 */
export const DEFAULT_MAX_VISIBLE = 12;

export interface TranscriptWindow {
  /** The newest messages, in order. */
  visible: Message[];
  /** How many older ones were left out. */
  hidden: number;
  /** Index of `visible[0]` in the full history, for stable keys. */
  start: number;
  /** How many newer ones are below the window — non-zero only when scrolled. */
  newer: number;
}

/** The last `maxVisible` messages, whatever the length of the history. */
export function windowMessages(
  messages: Message[],
  maxVisible: number = DEFAULT_MAX_VISIBLE,
): TranscriptWindow {
  const start = Math.max(0, messages.length - Math.max(1, maxVisible));
  return { visible: messages.slice(start), hidden: start, start, newer: 0 };
}

/**
 * Rows one message occupies once drawn: a header line, a bordered body, and
 * whatever its tool calls and diffs add.
 *
 * Counting messages instead of rows was what let the transcript outgrow the
 * terminal — twelve one-line replies fit, twelve code-heavy ones did not, and
 * the overflow pushed the prompt off the bottom of the screen.
 */
export function estimateMessageRows(message: Message, width: number): number {
  const usable = Math.max(20, width - 4); // padding
  let rows = 1; // the speaker line

  for (const line of message.content.split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / usable));
  }

  // Both asked of the component that draws them rather than guessed here. Every
  // frame overflow so far has been an estimate that disagreed with the render:
  // diffs once said 12 here and drew 50, and tool calls said one row each while
  // a finished call draws two.
  if (message.toolCalls?.length) rows += toolCallViewRows(message.toolCalls);
  for (const diff of message.diffs ?? []) {
    rows += diffViewRows(diff.unified);
  }

  return rows;
}

/**
 * The newest messages that fit in `maxRows`, walking backwards from the end.
 * The newest message is always kept even when it alone overflows — dropping it
 * would blank the screen exactly when there is something to read.
 */
export function fitMessages(
  messages: Message[],
  maxRows: number,
  width: number,
  scrollOffset: number = 0,
): TranscriptWindow {
  if (messages.length === 0) return { visible: [], hidden: 0, start: 0, newer: 0 };

  // Scrolling back moves the *end* of the window earlier in the history; the
  // fitting below then fills upward from there exactly as it does at the bottom.
  const end = Math.max(1, messages.length - Math.max(0, scrollOffset));
  const budget = Math.max(1, maxRows);
  let used = 0;
  let start = end;

  for (let i = end - 1; i >= 0; i--) {
    const rows = estimateMessageRows(messages[i]!, width) + 1; // +1 for the gap
    if (used + rows > budget && start < end) break;
    used += rows;
    start = i;
  }

  return {
    visible: messages.slice(start, end),
    hidden: start,
    start,
    newer: messages.length - end,
  };
}

/** Largest useful scroll offset — one short of scrolling past the first message. */
export function maxScrollOffset(messages: Message[]): number {
  return Math.max(0, messages.length - 1);
}

/**
 * A scroll banner: its own line plus the gap row the surrounding `gap={1}` puts
 * above it. Both are truncated rather than wrapped so the cost stays two rows at
 * any width — the long unwrapped wording used to spend three or four rows that
 * nothing had reserved, which is enough on its own to overflow the frame.
 */
export const BANNER_ROWS = 2;

export function ChatView({
  messages,
  streamingText,
  maxVisible = DEFAULT_MAX_VISIBLE,
  maxRows,
  width = 80,
  scrollOffset = 0,
}: ChatViewProps) {
  // Reserve room for the in-flight reply so a long stream does not shove the
  // prompt off-screen mid-turn.
  const streamRows = streamingText
    ? estimateMessageRows({ role: "assistant", content: streamingText }, width)
    : 0;

  // Whether the "↓ N newer" banner appears is known before fitting, so its rows
  // come straight off the budget.
  const newerRows = scrollOffset > 0 && messages.length > 1 ? BANNER_ROWS : 0;

  let win: TranscriptWindow;
  if (maxRows === undefined) {
    win = windowMessages(messages, maxVisible);
  } else {
    const budget = Math.max(1, maxRows - streamRows - newerRows);
    // "↑ N earlier" is circular: whether it is drawn depends on the fit, and
    // drawing it costs rows the fit has already handed out. So fit with the
    // reservation, and only fit again without it if it turns out unneeded —
    // which cannot reintroduce hidden messages, since a larger budget never
    // drops one.
    win = fitMessages(messages, Math.max(1, budget - BANNER_ROWS), width, scrollOffset);
    if (win.hidden === 0) win = fitMessages(messages, budget, width, scrollOffset);
  }

  const { visible, hidden, start, newer } = win;

  return (
    <Box flexDirection="column" gap={1}>
      {hidden > 0 && (
        <Text color="gray" dimColor wrap="truncate">
          ↑ {hidden} earlier — PgUp/ctrl-U to scroll back
        </Text>
      )}
      {visible.map((msg, i) => (
        // Keyed by position in the whole history, not in the window: a window
        // index would shift under every message and remount the subtree.
        <MessageRow key={start + i} message={msg} />
      ))}
      {streamingText !== undefined && streamingText !== "" && (
        <MessageBubble role="assistant" content={streamingText} streaming />
      )}
      {newer > 0 && (
        // Without this, scrolling up looks like the conversation was lost.
        <Text color="yellow" dimColor wrap="truncate">
          ↓ {newer} newer — PgDn/ctrl-D · ctrl-G for the latest
        </Text>
      )}
    </Box>
  );
}

/**
 * Memoized on the message object, which never changes once its turn is over —
 * otherwise every keystroke re-renders every line in the window.
 */
const MessageRow = React.memo(function MessageRow({ message }: { message: Message }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {message.content !== "" && <MessageBubble role={message.role} content={message.content} />}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolCallView calls={message.toolCalls} />
      )}
      {message.diffs?.map((diff, i) => (
        <DiffView key={i} unified={diff.unified} filePath={diff.path} fuzzy={diff.fuzzy} />
      ))}
    </Box>
  );
});

/**
 * A turn in the transcript.
 *
 * The two roles are told apart by weight rather than by matching frames: what
 * you said is a solid grey block, what the model said is unframed body text on
 * the terminal's own background. Two identical bordered boxes in different
 * colours made every turn shout equally loudly and the transcript hard to skim.
 */
function MessageBubble({
  role,
  content,
  streaming,
}: {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  const lines = content.split("\n");

  if (isUser) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color="cyan" bold>
          {GLYPH.user} you
        </Text>
        {lines.map((line, i) => (
          // Inverted block: dark text on grey reads as "this is mine, it is
          // settled" and needs no border to separate it from the reply below.
          <Text key={i} backgroundColor="gray" color="black" wrap="wrap">
            {` ${line || " "} `}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box>
        <Text color="green" bold>
          {GLYPH.agent} codemon
        </Text>
        {streaming ? <Text color="yellow"> ▋</Text> : null}
      </Box>
      <Box paddingLeft={1} flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} wrap="wrap">
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";
import { ToolCallView, type ToolCallEntry } from "./ToolCallView.tsx";
import { DiffView, type DiffEntry } from "./DiffView.tsx";

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
}

/** The last `maxVisible` messages, whatever the length of the history. */
export function windowMessages(
  messages: Message[],
  maxVisible: number = DEFAULT_MAX_VISIBLE,
): TranscriptWindow {
  const start = Math.max(0, messages.length - Math.max(1, maxVisible));
  return { visible: messages.slice(start), hidden: start, start };
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
  const usable = Math.max(20, width - 4); // borders and padding
  let rows = 1 + 2; // header + top/bottom border

  for (const line of message.content.split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / usable));
  }

  // Tool calls render one line each plus a frame; diffs are capped by DiffView.
  if (message.toolCalls?.length) rows += message.toolCalls.length + 2;
  for (const diff of message.diffs ?? []) {
    rows += Math.min(12, diff.unified.split("\n").length) + 2;
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
): TranscriptWindow {
  if (messages.length === 0) return { visible: [], hidden: 0, start: 0 };

  const budget = Math.max(1, maxRows);
  let used = 0;
  let start = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const rows = estimateMessageRows(messages[i]!, width) + 1; // +1 for the gap
    if (used + rows > budget && start < messages.length) break;
    used += rows;
    start = i;
  }

  return { visible: messages.slice(start), hidden: start, start };
}

export function ChatView({
  messages,
  streamingText,
  maxVisible = DEFAULT_MAX_VISIBLE,
  maxRows,
  width = 80,
}: ChatViewProps) {
  // Reserve room for the in-flight reply so a long stream does not shove the
  // prompt off-screen mid-turn.
  const streamRows = streamingText
    ? estimateMessageRows({ role: "assistant", content: streamingText }, width)
    : 0;

  const { visible, hidden, start } =
    maxRows === undefined
      ? windowMessages(messages, maxVisible)
      : fitMessages(messages, Math.max(1, maxRows - streamRows), width);

  return (
    <Box flexDirection="column" gap={1}>
      {hidden > 0 && (
        <Text dimColor>
          … {hidden} earlier message{hidden === 1 ? "" : "s"} hidden — the full history is still in
          the session and still sent to the model …
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
    </Box>
  );
}

/**
 * Memoized on the message object, which never changes once its turn is over —
 * otherwise every keystroke re-renders every line in the window.
 */
const MessageRow = React.memo(function MessageRow({ message }: { message: Message }) {
  return (
    <Box flexDirection="column">
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

  return (
    <Box flexDirection="column">
      <Box marginBottom={0}>
        <Text
          color={isUser ? "cyan" : "green"}
          bold
        >
          {isUser ? "⚡ You" : "🐉 Codemon"}
          {streaming ? <Text color="yellow"> ▋</Text> : null}
        </Text>
      </Box>
      <Box paddingLeft={2} borderStyle="single" borderColor={isUser ? "cyan" : "green"} flexDirection="column">
        {content.split("\n").map((line, i) => (
          <Text key={i} wrap="wrap">
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

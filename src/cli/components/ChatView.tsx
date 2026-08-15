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
}

/**
 * The transcript is `overflow="hidden"` with no scrollback, so anything taller
 * than the terminal is unreachable anyway — rendering it only costs a re-layout
 * of every line on every keystroke, since the input box shares this tree.
 * Windowing keeps that cost flat as a session grows.
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

export function ChatView({ messages, streamingText, maxVisible = DEFAULT_MAX_VISIBLE }: ChatViewProps) {
  const { visible, hidden, start } = windowMessages(messages, maxVisible);

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
 * Memoized on the message object, which never changes once its turn is over.
 * Without this, typing a character re-splits and re-renders every line of every
 * message in the window.
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

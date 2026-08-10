import React from "react";
import { Box, Text } from "ink";

interface Message {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

interface ChatViewProps {
  messages: Message[];
  streamingText?: string;
}

export function ChatView({ messages, streamingText }: ChatViewProps) {
  return (
    <Box flexDirection="column" gap={1}>
      {messages.map((msg, i) => (
        <MessageBubble key={i} role={msg.role} content={msg.content} />
      ))}
      {streamingText !== undefined && streamingText !== "" && (
        <MessageBubble role="assistant" content={streamingText} streaming />
      )}
    </Box>
  );
}

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

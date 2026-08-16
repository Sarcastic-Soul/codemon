import React from "react";
import { Box, Text } from "ink";
import { GLYPH } from "../theme.ts";

/** Reasoning lines kept on screen. It is context, not the answer. */
const MAX_LINES = 6;

/** The last `max` lines of a reasoning stream, wrapped to `width`. */
export function tailLines(text: string, max: number = MAX_LINES, width = 76): string[] {
  const wrapped: string[] = [];

  for (const line of text.split("\n")) {
    if (line === "") continue;
    for (let i = 0; i < line.length; i += width) {
      wrapped.push(line.slice(i, i + width));
    }
  }

  return wrapped.slice(-max);
}

interface ReasoningViewProps {
  text: string;
  width?: number;
}

/**
 * The model's scratchpad, for models that emit one.
 *
 * Deliberately dim and tail-only: it is the least important thing on screen but
 * the only sign of progress during a long think, so it must be visible without
 * competing with the reply.
 */
export function ReasoningView({ text, width = 76 }: ReasoningViewProps) {
  if (!text.trim()) return null;

  const lines = tailLines(text, MAX_LINES, Math.max(20, width - 6));

  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={1} marginTop={1}>
      <Text color="magenta" dimColor>
        {GLYPH.section} reasoning
      </Text>
      {lines.map((line, i) => (
        <Text key={i} color="gray" dimColor wrap="truncate">
          {"  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}

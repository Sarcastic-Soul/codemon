import React from "react";
import { Box, Text } from "ink";
import type { Suggestion } from "../suggestions.ts";

interface SuggestionPopupProps {
  suggestions: Suggestion[];
  selectedIndex: number;
}

/**
 * The completion list, drawn directly above the prompt.
 *
 * Sized to its contents rather than a fixed height so it never pushes the input
 * off the bottom of a short terminal.
 */
export const SuggestionPopup = React.memo(function SuggestionPopup({
  suggestions,
  selectedIndex,
}: SuggestionPopupProps) {
  if (suggestions.length === 0) return null;

  const kind = suggestions[0]!.kind;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      {suggestions.map((suggestion, index) => {
        const isSelected = index === selectedIndex;
        return (
          <Box key={`${suggestion.kind}:${suggestion.value}`}>
            <Text color={isSelected ? "magenta" : "gray"} bold={isSelected}>
              {isSelected ? "› " : "  "}
              {suggestion.kind === "command" ? suggestion.label : suggestion.value}
            </Text>
            {suggestion.detail ? <Text dimColor> {suggestion.detail}</Text> : null}
          </Box>
        );
      })}
      <Text dimColor>
        {kind === "command" ? "commands" : "files"} · ↑/↓ move · Tab or Enter accept · Esc dismiss
      </Text>
    </Box>
  );
});

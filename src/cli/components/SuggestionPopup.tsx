import React from "react";
import { Box, Text } from "ink";
import { SUGGESTION_WINDOW, type Suggestion } from "../suggestions.ts";
import { GLYPH } from "../theme.ts";

interface SuggestionPopupProps {
  suggestions: Suggestion[];
  selectedIndex: number;
  /** Rows the layout can spare. 0 hides the popup entirely. */
  maxVisibleRows?: number;
}

/**
 * Slide a fixed window over the matches so the highlighted row stays visible.
 * Exported for the tests: an off-by-one here strands the cursor off-screen,
 * which reads as the arrow keys having stopped working.
 */
export function suggestionWindow(
  total: number,
  selectedIndex: number,
  size: number = SUGGESTION_WINDOW,
): { offset: number; size: number } {
  if (total <= size) return { offset: 0, size: total };
  const half = Math.floor(size / 2);
  const offset = Math.min(Math.max(selectedIndex - half, 0), total - size);
  return { offset, size };
}

/**
 * The completion list, drawn directly above the prompt. Height is bounded by the
 * window, so a 300-file match still leaves the prompt on screen.
 */
export const SuggestionPopup = React.memo(function SuggestionPopup({
  suggestions,
  selectedIndex,
  maxVisibleRows = SUGGESTION_WINDOW,
}: SuggestionPopupProps) {
  if (suggestions.length === 0 || maxVisibleRows < 1) return null;

  const { offset, size } = suggestionWindow(suggestions.length, selectedIndex, maxVisibleRows);
  const visible = suggestions.slice(offset, offset + size);
  const kind = suggestions[0]!.kind;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} flexShrink={0}>
      {visible.map((suggestion, index) => {
        const isSelected = offset + index === selectedIndex;
        return (
          <Box key={`${suggestion.kind}:${suggestion.value}`} flexShrink={0}>
            <Text color={isSelected ? "magenta" : "white"} bold={isSelected} wrap="truncate">
              {isSelected ? `${GLYPH.cursor} ` : "  "}
              {suggestion.kind === "command" ? suggestion.label : suggestion.value}
            </Text>
            {suggestion.detail ? (
              <Text color="gray" dimColor wrap="truncate">
                {"  "}
                {suggestion.detail}
              </Text>
            ) : null}
          </Box>
        );
      })}

      <Box flexShrink={0}>
        <Text color="gray" dimColor>
          {suggestions.length > size
            ? `${selectedIndex + 1}/${suggestions.length} ${kind === "command" ? "commands" : "files"} · ↑/↓ scroll · Tab accept · Esc dismiss`
            : `${suggestions.length} ${kind === "command" ? "commands" : "files"} · ↑/↓ move · Tab accept · Esc dismiss`}
        </Text>
      </Box>
    </Box>
  );
});

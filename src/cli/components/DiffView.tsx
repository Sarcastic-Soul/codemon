import { Box, Text } from "ink";
import { parseDiffLines } from "../../utils/diff-apply.ts";
import { GLYPH } from "../theme.ts";

/** One file edit, kept with the message whose turn produced it. */
export interface DiffEntry {
  unified: string;
  path: string;
  /** Set when the edit was placed by similarity rather than an exact match. */
  fuzzy?: { similarity: number };
}

/**
 * Diff body lines drawn by default.
 *
 * This was 50, which alone overflows a 40-row terminal. Once the frame is taller
 * than the screen Ink stops updating in place and starts scrolling, which is
 * what redrew the side panel over and over down the window.
 */
export const DIFF_MAX_LINES = 12;

/**
 * Rows a DiffView occupies: `marginY={1}` above and below, the title, the two
 * border rows, the body, and the truncation notice.
 *
 * The margin is two rows, not one — this counted it as one, so every diff on
 * screen was a row of overflow the layout never reserved.
 */
export function diffViewRows(unified: string, maxLines: number = DIFF_MAX_LINES): number {
  const lines = unified.split("\n").length;
  return 2 + 1 + 2 + Math.min(lines, maxLines) + (lines > maxLines ? 1 : 0);
}

interface DiffViewProps {
  unified: string;
  filePath: string;
  /** Set when the edit was placed by similarity rather than an exact match. */
  fuzzy?: { similarity: number };
  /** Body lines to draw before truncating. */
  maxLines?: number;
}

export function DiffView({ unified, filePath, fuzzy, maxLines = DIFF_MAX_LINES }: DiffViewProps) {
  const lines = parseDiffLines(unified);

  return (
    <Box flexDirection="column" marginY={1} flexShrink={0}>
      <Box gap={1}>
        <Text bold color="yellow" wrap="truncate">
          {GLYPH.section} diff {filePath}
        </Text>
        {fuzzy && (
          <Text color="magenta" wrap="truncate">
            {GLYPH.warn} fuzzy match ({Math.round(fuzzy.similarity * 100)}%)
          </Text>
        )}
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        {/* Every body line is truncated, never wrapped. `diffViewRows` promises
            the layout one row per diff line; a single long line of source that
            wrapped would break that promise and overflow the frame. */}
        {lines.slice(0, maxLines).map((dl, i) => {
          if (dl.type === "header") {
            return (
              <Text key={i} color="cyan" dimColor wrap="truncate">
                {dl.line}
              </Text>
            );
          }
          if (dl.type === "add") {
            return (
              <Text key={i} color="green" wrap="truncate">
                {dl.line}
              </Text>
            );
          }
          if (dl.type === "remove") {
            return (
              <Text key={i} color="red" wrap="truncate">
                {dl.line}
              </Text>
            );
          }
          return (
            <Text key={i} dimColor wrap="truncate">
              {dl.line}
            </Text>
          );
        })}
        {lines.length > maxLines && (
          <Text color="gray" dimColor wrap="truncate">
            … {lines.length - maxLines} more lines — the full diff is on disk …
          </Text>
        )}
      </Box>
    </Box>
  );
}

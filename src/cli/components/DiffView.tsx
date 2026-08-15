import React from "react";
import { Box, Text } from "ink";
import { parseDiffLines } from "../../utils/diff-apply.ts";

/** One file edit, kept with the message whose turn produced it. */
export interface DiffEntry {
  unified: string;
  path: string;
  /** Set when the edit was placed by similarity rather than an exact match. */
  fuzzy?: { similarity: number };
}

interface DiffViewProps {
  unified: string;
  filePath: string;
  /** Set when the edit was placed by similarity rather than an exact match. */
  fuzzy?: { similarity: number };
}

export function DiffView({ unified, filePath, fuzzy }: DiffViewProps) {
  const lines = parseDiffLines(unified);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box gap={1}>
        <Text bold color="yellow">
          📝 Diff — {filePath}
        </Text>
        {fuzzy && (
          <Text color="magenta">
            ⚠ fuzzy match ({Math.round(fuzzy.similarity * 100)}%)
          </Text>
        )}
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
        {lines.slice(0, 50).map((dl, i) => {
          if (dl.type === "header") {
            return (
              <Text key={i} color="cyan" dimColor>
                {dl.line}
              </Text>
            );
          }
          if (dl.type === "add") {
            return (
              <Text key={i} color="green">
                {dl.line}
              </Text>
            );
          }
          if (dl.type === "remove") {
            return (
              <Text key={i} color="red">
                {dl.line}
              </Text>
            );
          }
          return (
            <Text key={i} dimColor>
              {dl.line}
            </Text>
          );
        })}
        {lines.length > 50 && (
          <Text dimColor>… {lines.length - 50} more lines …</Text>
        )}
      </Box>
    </Box>
  );
}

import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { PokeballSpinner } from "./PokeballSpinner.tsx";
import { ALL_COMMANDS } from "../commands/index.ts";
import { GLYPH } from "../theme.ts";

/** How long each tip stays up. Long enough to read, short enough to cycle. */
const TIP_ROTATE_MS = 4000;

/**
 * Shown while a turn is in flight.
 *
 * The tips are built from the command registry rather than written out here, so
 * a new command starts being advertised the moment it is registered — and they
 * moved into this rotation when the permanent cheatsheet left the side panel.
 */
export function buildTips(): string[] {
  const commandTips = ALL_COMMANDS.map((cmd) => {
    const aliases = cmd.names.slice(1);
    const alias = aliases.length > 0 ? `  (also ${aliases.join(", ")})` : "";
    return `${cmd.names[0]} — ${cmd.description}${alias}`;
  });

  return [
    ...commandTips,
    "@ a path to point Codemon straight at a file or folder",
    "↑/↓ scroll the completion list, Tab accepts the highlighted row",
    "ctrl-C exits; your session is saved and --continue resumes it",
    "--rewind restores every file the last session touched",
  ];
}

interface ThinkingIndicatorProps {
  /** Elapsed-time label, e.g. what the caller counts in seconds. */
  elapsedSeconds?: number;
  /** Injected by the tests so rotation is deterministic. */
  tipIndex?: number;
}

export function ThinkingIndicator({ elapsedSeconds, tipIndex }: ThinkingIndicatorProps) {
  const tips = buildTips();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (tipIndex !== undefined) return; // controlled — no timer
    const timer = setInterval(() => setIndex((i) => (i + 1) % tips.length), TIP_ROTATE_MS);
    return () => clearInterval(timer);
  }, [tipIndex, tips.length]);

  const tip = tips[(tipIndex ?? index) % tips.length];

  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={1}>
      {/* Each line is a single truncating `Text`, not a `Box` of several.
          Laid out as a row, the pieces are measured individually and a narrow
          terminal breaks the line in two with the fragments reordered — at 24
          columns this drew "12 · ctrl-C to…" above "thinking". As one Text the
          line is cut once, on the right, and holds the two rows the layout
          reserves for the indicator. */}
      <Text wrap="truncate">
        <PokeballSpinner />
        <Text color="yellow" bold>
          {" "}
          thinking
        </Text>
        {elapsedSeconds !== undefined && elapsedSeconds > 0 ? (
          <Text color="gray" dimColor> {elapsedSeconds}s</Text>
        ) : null}
        <Text color="gray" dimColor> · ctrl-C to stop</Text>
      </Text>

      {/* Truncated for the same reason and one more: the tip rotates, so a long
          command description wraps where a short one does not, and an unwrapped
          tip changed the indicator's height every four seconds. */}
      <Text color="gray" dimColor wrap="truncate">
        {GLYPH.info} {tip}
      </Text>
    </Box>
  );
}

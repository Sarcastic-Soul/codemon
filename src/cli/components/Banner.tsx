import React from "react";
import { Box, Text } from "ink";

/**
 * Drawn once, on an empty transcript.
 *
 * Three tiers, picked by what actually fits: pokéball beside the wordmark, the
 * wordmark alone, then a single line. A banner that wraps is worse than no
 * banner — it is the first thing drawn, and a wrapped one pushes the prompt off
 * a short screen.
 */
const WORDMARK = [
  " ██████╗ ██████╗ ██████╗ ███████╗███╗   ███╗ ██████╗ ███╗   ██╗",
  "██╔════╝██╔═══██╗██╔══██╗██╔════╝████╗ ████║██╔═══██╗████╗  ██║",
  "██║     ██║   ██║██║  ██║█████╗  ██╔████╔██║██║   ██║██╔██╗ ██║",
  "██║     ██║   ██║██║  ██║██╔══╝  ██║╚██╔╝██║██║   ██║██║╚██╗██║",
  "╚██████╗╚██████╔╝██████╔╝███████╗██║ ╚═╝ ██║╚██████╔╝██║ ╚████║",
  " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
];

const WORDMARK_WIDTH = 63;

/**
 * Pokéball, one row per colour band: red shell, dark seam with the catch, pale
 * lower half. Six rows so it lines up with the wordmark beside it.
 */
const POKEBALL: Array<{ art: string; color: string }> = [
  { art: "   ▄▄▄▄▄▄▄▄▄   ", color: "red" },
  { art: " ▄███████████▄ ", color: "red" },
  { art: "███████████████", color: "red" },
  { art: "▀▀▀▀▀▀ ● ▀▀▀▀▀▀", color: "gray" },
  { art: "███████████████", color: "white" },
  { art: " ▀███████████▀ ", color: "white" },
];

const POKEBALL_WIDTH = 15;
const PAIR_WIDTH = POKEBALL_WIDTH + 2 + WORDMARK_WIDTH;

interface BannerProps {
  model: string;
  /** Rows the banner may use; it degrades as the terminal shrinks. */
  maxRows?: number;
  /** Columns available; art is dropped rather than wrapped. */
  width?: number;
}

export function Banner({ model, maxRows = 24, width = 80 }: BannerProps) {
  const tall = maxRows >= WORDMARK.length + 4;
  const variant = !tall || width < WORDMARK_WIDTH ? "line" : width >= PAIR_WIDTH ? "pair" : "wordmark";

  return (
    <Box flexDirection="column" paddingLeft={1} flexShrink={0}>
      {variant === "line" ? (
        <Text color="green" bold>
          ◓ C O D E M O N
        </Text>
      ) : (
        <Box flexDirection="row" flexShrink={0}>
          {variant === "pair" && (
            <Box flexDirection="column" marginRight={2} flexShrink={0}>
              {POKEBALL.map((row, i) => (
                <Text key={i} color={row.color} bold>
                  {row.art}
                </Text>
              ))}
            </Box>
          )}
          <Box flexDirection="column" flexShrink={0}>
            {WORDMARK.map((line, i) => (
              <Text key={i} color="green" bold>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* The tagline and hints are the first thing dropped on a short screen. */}
      {maxRows >= 10 && (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color="gray" dimColor>
            your AI coding partner — tools are moves, the LLM is your Codemon
          </Text>
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              model{" "}
            </Text>
            <Text color="blue">{model}</Text>
          </Box>
          <Text color="gray" dimColor>
            type <Text color="magenta">/</Text> for commands ·{" "}
            <Text color="magenta">@</Text> to reference a file · ctrl-C to exit
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Which layout the banner picks. Exported so the tests can pin the thresholds. */
export function bannerVariant(maxRows: number, width: number): "pair" | "wordmark" | "line" {
  const tall = maxRows >= WORDMARK.length + 4;
  if (!tall || width < WORDMARK_WIDTH) return "line";
  return width >= PAIR_WIDTH ? "pair" : "wordmark";
}

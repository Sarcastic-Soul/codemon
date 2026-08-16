import React from "react";
import { Box, Text } from "ink";
import { formatTokenCount } from "../../utils/tokenizer.ts";
import { ALL_COMMANDS } from "../commands/index.ts";

interface SidePanelProps {
  model: string;
  region: string;
  permissionMode: string;
  /** What the history currently occupies — the number truncation acts on. */
  contextTokens: number;
  /** The budget that same truncation measures against. */
  maxContextTokens: number;
  /** Cumulative prompt + completion tokens billed this session. */
  spentTokens: number;
  isThinking: boolean;
  resumed: boolean;
  sessionId?: string;
}

const PROVIDER_ICONS: Record<string, string> = {
  google: "🔵",
  anthropic: "🟠",
  openai: "🟢",
  mistral: "🟣",
};
const MODE_ICONS: Record<string, string> = {
  safe: "🛡️ ",
  standard: "⚾ ",
  yolo: "🔥 ",
};
const MODE_COLORS: Record<string, string> = {
  safe: "green",
  standard: "yellow",
  yolo: "red",
};

/** Read from the dispatcher's registry, so the cheatsheet cannot drift. */
const COMMANDS = ALL_COMMANDS.map((cmd) => ({
  name: cmd.names[0] ?? "/unknown",
  desc: cmd.hint,
}));

/** Matches the context manager: it trims at 80% and trims down to 60%. */
const WARN_PERCENT = 60;
const TRIM_PERCENT = 80;

const BAR_WIDTH = 16;

export interface ContextMeter {
  percentUsed: number;
  bar: string;
  color: string;
}

/**
 * Context occupancy — how full the window the agent loop trims is, rather than
 * cumulative spend, so the bar moves when the history is actually trimmed.
 */
export function contextMeter(
  contextTokens: number,
  maxContextTokens: number,
  width: number = BAR_WIDTH,
): ContextMeter {
  const budget = maxContextTokens > 0 ? maxContextTokens : 1;
  const percentUsed = Math.max(0, Math.min(100, Math.round((contextTokens / budget) * 100)));
  const filled = Math.min(width, Math.round((percentUsed / 100) * width));
  return {
    percentUsed,
    bar: "█".repeat(filled) + "░".repeat(width - filled),
    color: percentUsed >= TRIM_PERCENT ? "red" : percentUsed >= WARN_PERCENT ? "yellow" : "green",
  };
}

function shortPath(p: string, max = 26): string {
  return p.length > max ? "…" + p.slice(p.length - max + 1) : p;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // flexShrink=0 because Yoga's default is to compress children that overflow
    // a fixed-height parent, which drew two lines on top of each other
    // ("● readyus") on a short terminal. Clipped from the bottom is legible;
    // squashed is not — and the sections are already ordered least-important-last.
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Text dimColor>{label}</Text>
      {children}
    </Box>
  );
}

/**
 * Memoized on its props: none of them change while a message is being typed, so
 * without this every keystroke re-rendered the whole panel — a third of the
 * screen redrawn per character, which is what made fast typing flicker.
 */
export const SidePanel = React.memo(function SidePanel({
  model,
  region,
  permissionMode,
  contextTokens,
  maxContextTokens,
  spentTokens,
  isThinking,
  resumed,
  sessionId,
}: SidePanelProps) {
  const sep = model.includes(":") ? ":" : model.includes("/") ? "/" : null;
  const sepIdx = sep ? model.indexOf(sep) : -1;
  const providerPart = sepIdx > -1 ? model.slice(0, sepIdx) : "";
  const modelPart = sepIdx > -1 ? model.slice(sepIdx + 1) : model;
  const providerIcon = PROVIDER_ICONS[providerPart] ?? "🤖";
  const modeIcon = MODE_ICONS[permissionMode] ?? "⚾ ";
  const modeColor = MODE_COLORS[permissionMode] ?? "white";

  const { percentUsed, bar: tokenBar, color: barColor } = contextMeter(
    contextTokens,
    maxContextTokens,
  );

  const divider = "─".repeat(24);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      height="100%"
      overflow="hidden"
    >
      {/* Title */}
      <Box justifyContent="center" marginBottom={1} flexShrink={0}>
        <Text bold color="magenta">🐉 CODEMON</Text>
      </Box>

      {/* Region */}
      <Row label="📁 region">
        <Text color="cyan" wrap="truncate">{shortPath(region)}</Text>
      </Row>

      <Text dimColor>{divider}</Text>

      {/* Model — the one section built by hand rather than through Row(), so it
          needs the same flexShrink=0 to keep its three lines from stacking. */}
      <Box flexDirection="column" marginTop={1} marginBottom={1} flexShrink={0}>
        <Text dimColor>🤖 model</Text>
        <Box gap={1} flexShrink={0}>
          <Text>{providerIcon}</Text>
          <Text color="blue" bold wrap="truncate">{modelPart}</Text>
        </Box>
        {providerPart ? <Text dimColor color="gray">{providerPart}</Text> : null}
      </Box>

      {/* Mode */}
      <Row label="🔒 mode">
        <Box gap={1}>
          <Text>{modeIcon}</Text>
          <Text color={modeColor} bold>{permissionMode}</Text>
        </Box>
      </Row>

      {/* Context occupancy — what the context manager trims on */}
      <Row label="🧠 context">
        <Text color="gray">
          ~{formatTokenCount(contextTokens)} / {formatTokenCount(maxContextTokens)}
        </Text>
        <Box gap={1}>
          <Text color={barColor}>{tokenBar}</Text>
          <Text dimColor>{percentUsed}%</Text>
        </Box>
      </Row>

      {/* Cumulative spend — a different quantity, so a different line */}
      <Row label="📊 spent">
        <Text color="gray">~{formatTokenCount(spentTokens)} tk</Text>
      </Row>

      {/* Status */}
      <Row label="💡 status">
        {isThinking && <Text color="yellow">⚡ thinking…</Text>}
        {!isThinking && resumed && <Text color="cyan">📖 resumed</Text>}
        {!isThinking && !resumed && <Text color="green">● ready</Text>}
        {sessionId && <Text dimColor color="gray">{sessionId.slice(0, 8)}…</Text>}
      </Row>

      <Text dimColor>{divider}</Text>

      {/* Commands cheatsheet — last, so it is what a short terminal clips */}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text dimColor>⌨️  commands</Text>
        {COMMANDS.map((c) => (
          <Box key={c.name} gap={1}>
            <Text color="cyan">{c.name}</Text>
            <Text dimColor>{c.desc}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
});

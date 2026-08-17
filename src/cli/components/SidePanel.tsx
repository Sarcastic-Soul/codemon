import React from "react";
import { Box, Text } from "ink";
import { formatTokenCount } from "../../utils/tokenizer.ts";
import { GLYPH, MODE_GLYPH, PROVIDER_GLYPH, PANEL_MARK } from "../theme.ts";
import type { Todo } from "../../core/todo-store.ts";

/** Todo rows the panel will draw before it starts eliding. */
export const TODO_VISIBLE_ROWS = 5;

/**
 * Which todos to show when there are more than fit.
 *
 * Centred on the work in flight rather than the top of the list: by item nine
 * the first eight are done and the only interesting row is the current one.
 */
export function visibleTodos(todos: Todo[], limit = TODO_VISIBLE_ROWS): Todo[] {
  if (todos.length <= limit) return todos;

  const active = todos.findIndex((t) => t.status === "in_progress");
  if (active === -1) {
    // Nothing running — the next pending items are what matters.
    const firstPending = todos.findIndex((t) => t.status === "pending");
    const start = firstPending === -1 ? todos.length - limit : firstPending;
    return todos.slice(start, start + limit);
  }

  const start = Math.max(0, Math.min(active - Math.floor(limit / 2), todos.length - limit));
  return todos.slice(start, start + limit);
}

const TODO_GLYPH: Record<Todo["status"], string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "○",
};

const TODO_COLOR: Record<Todo["status"], string> = {
  completed: "green",
  in_progress: "yellow",
  pending: "gray",
};

interface SidePanelProps {
  model: string;
  region: string;
  permissionMode: string;
  /** True while the agent may investigate but not change anything. */
  planMode?: boolean;
  /** The agent's checklist, if it has written one. */
  todos?: Todo[];
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

const MODE_COLORS: Record<string, string> = {
  safe: "green",
  standard: "yellow",
  yolo: "red",
};

/** Read from the dispatcher's registry, so the cheatsheet cannot drift. */

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
  planMode = false,
  todos = [],
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

  const modeGlyph = MODE_GLYPH[permissionMode] ?? MODE_GLYPH.standard!;
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
      <Box flexDirection="column" alignItems="center" marginBottom={1} flexShrink={0}>
        {PANEL_MARK.map((line, i) => (
          <Text key={i} bold color={i === 1 ? "red" : "gray"}>
            {line}
          </Text>
        ))}
        <Text bold color="magenta">CODEMON</Text>
      </Box>

      {/* Region */}
      <Row label={`${GLYPH.section} region`}>
        <Text color="cyan" wrap="truncate">{shortPath(region)}</Text>
      </Row>

      <Text dimColor>{divider}</Text>

      {/* Model — the one section built by hand rather than through Row(), so it
          needs the same flexShrink=0 to keep its three lines from stacking. */}
      <Box flexDirection="column" marginTop={1} marginBottom={1} flexShrink={0}>
        <Text dimColor>{GLYPH.section} model</Text>
        <Box gap={1} flexShrink={0}>
          <Text color="red">{PROVIDER_GLYPH}</Text>
          <Text color="blue" bold wrap="truncate">{modelPart}</Text>
        </Box>
        {providerPart ? <Text dimColor color="gray">{providerPart}</Text> : null}
      </Box>

      {/* Mode. Plan mode is a second line rather than a replacement: it is an
          independent axis, and the permission mode still governs everything it
          does not deny outright. */}
      <Row label={`${GLYPH.section} mode`}>
        <Box gap={1}>
          <Text color={modeColor}>{modeGlyph}</Text>
          <Text color={modeColor} bold>{permissionMode}</Text>
        </Box>
        {planMode && <Text color="magenta" bold>[~] PLAN — read only</Text>}
      </Row>

      {/* Context occupancy — what the context manager trims on */}
      <Row label={`${GLYPH.section} context`}>
        <Text color="gray">
          ~{formatTokenCount(contextTokens)} / {formatTokenCount(maxContextTokens)}
        </Text>
        <Box gap={1}>
          <Text color={barColor}>{tokenBar}</Text>
          <Text dimColor>{percentUsed}%</Text>
        </Box>
      </Row>

      {/* Cumulative spend — a different quantity, so a different line */}
      <Row label={`${GLYPH.section} spent`}>
        <Text color="gray">~{formatTokenCount(spentTokens)} tk</Text>
      </Row>

      {/* Status */}
      <Row label={`${GLYPH.section} status`}>
        {isThinking && <Text color="yellow">{GLYPH.warn} thinking…</Text>}
        {!isThinking && resumed && <Text color="cyan">{GLYPH.info} resumed</Text>}
        {!isThinking && !resumed && <Text color="green">{GLYPH.ok} ready</Text>}
        {sessionId && <Text dimColor color="gray">{sessionId.slice(0, 8)}…</Text>}
      </Row>

      {/* The agent's checklist, last because the panel clips from the bottom:
          a variable-height block above the meters would push them off a short
          terminal, and the meters are what the user reads at a glance. */}
      {todos.length > 0 && (
        <Row
          label={`${GLYPH.section} todos  ${todos.filter((t) => t.status === "completed").length}/${todos.length}`}
        >
          {visibleTodos(todos).map((todo, i) => (
            <Text key={i} color={TODO_COLOR[todo.status]} wrap="truncate">
              {TODO_GLYPH[todo.status]} {todo.content}
            </Text>
          ))}
        </Row>
      )}
    </Box>
  );
});

/**
 * The visual vocabulary: glyphs, the pokéball spinner, and small ASCII art.
 *
 * Everything here is drawn from the geometric and box-drawing blocks rather than
 * from emoji. Emoji render at inconsistent widths across terminals — a two-cell
 * glyph in a one-cell slot shifts every column after it — and they carry their
 * own colour, so they ignore the palette around them. Text glyphs stay one cell
 * wide, take the colour they are given, and sit on the monospace grid.
 *
 * Kept in one module so the iconography can be changed in one place rather than
 * hunted through fifteen components.
 */

/**
 * The pokéball, half-shaded four ways. Cycled in order it reads as a ball
 * turning on the spot — the seam sweeps around rather than the glyph merely
 * blinking, which is what makes it look like rotation instead of a flicker.
 */
export const POKEBALL_FRAMES = ["◓", "◑", "◒", "◐"] as const;

/** Milliseconds per spinner frame. Slow enough to read as a spin, not a strobe. */
export const SPINNER_INTERVAL_MS = 120;

/** A pokéball at rest — the mark used wherever Codemon signs its own name. */
export const POKEBALL = "◓";

export const GLYPH = {
  /** Section markers in the side panel. */
  section: "▸",
  /** The prompt caret. */
  prompt: "❯",
  /** Selected row in a list. */
  cursor: "›",
  /** Codemon's own turns. */
  agent: POKEBALL,
  /** The operator's turns. */
  user: "▪",

  ok: "+",
  fail: "!",
  warn: "*",
  info: "·",
  ask: "?",

  /** Filled and empty cells of the context meter. */
  barFilled: "█",
  barEmpty: "░",

  /** Leads the line under a tool call that reports its result. */
  branch: "└",
  divider: "─",
} as const;

/** Permission modes, least to most permissive. */
export const MODE_GLYPH: Record<string, string> = {
  safe: "[=]",
  standard: "[o]",
  yolo: "[!]",
};

/**
 * Providers get a pokéball in their own colour rather than a coloured-circle
 * emoji, so the side panel reads as one palette instead of a sticker sheet.
 */
export const PROVIDER_GLYPH = POKEBALL;

/**
 * Master ball, for the side panel header. Six columns wide so it sits inside the
 * panel's 34 with room for the title.
 */
export const PANEL_MARK = ["╭───╮", "│ ◓ │", "╰───╯"] as const;

/** Rotates the pokéball by index — used by the spinner and testable directly. */
export function spinnerFrame(tick: number): string {
  const frames = POKEBALL_FRAMES;
  return frames[((tick % frames.length) + frames.length) % frames.length]!;
}

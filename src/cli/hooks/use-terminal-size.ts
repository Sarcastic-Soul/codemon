import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Sane values for a pipe or a terminal that reports nothing. */
export const FALLBACK_SIZE: TerminalSize = { columns: 80, rows: 24 };

function readSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  const columns = stdout?.columns;
  const rows = stdout?.rows;
  return {
    columns: typeof columns === "number" && columns > 0 ? columns : FALLBACK_SIZE.columns,
    rows: typeof rows === "number" && rows > 0 ? rows : FALLBACK_SIZE.rows,
  };
}

/**
 * Current terminal size, tracked across resizes.
 *
 * The layout needs a real row count. Without one the root box grows past the
 * bottom of the screen, the terminal scrolls to keep up, and every repaint
 * redraws the scrolled-off frame too — which is what made the side panel look
 * like it drifted upward and made fast typing flicker.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    if (!stdout) return;

    const onResize = () => setSize(readSize(stdout));
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

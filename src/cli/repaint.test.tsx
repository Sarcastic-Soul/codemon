/**
 * How much of the screen does one small change repaint?
 *
 * This is the flicker. Ink's default write path erases the entire previous frame
 * and writes it back, so on a frame that fills the terminal — which this app's
 * always does — one changed character wipes and repaints the whole screen.
 * `incrementalRendering` makes Ink diff line by line instead, but it is off by
 * default in Ink 7, and nothing else in the suite would notice if that argument
 * were dropped.
 */
import { describe, test, expect } from "bun:test";
import { render, Box, Text } from "ink";
import { EventEmitter } from "events";
import { stripAnsi } from "./debug-frames.ts";

const ROWS = 30;
const COLUMNS = 80;

class FakeTerminal extends EventEmitter {
  isTTY = true;
  columns = COLUMNS;
  rows = ROWS;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/** The app's shape: a full-height root, a transcript, and a pinned prompt. */
function Screen({ tail }: { tail: string }) {
  return (
    <Box flexDirection="column" width={COLUMNS} height={ROWS}>
      <Box flexDirection="column" flexGrow={1}>
        {Array.from({ length: ROWS - 6 }, (_, i) => (
          <Text key={i}>transcript line {i}</Text>
        ))}
        <Text>{tail}</Text>
      </Box>
      <Box borderStyle="single" flexShrink={0}>
        <Text>prompt</Text>
      </Box>
    </Box>
  );
}

/** Lines rewritten when only the last row of content changes. */
async function linesRepaintedOnOneLineChange(incrementalRendering: boolean): Promise<number> {
  const term = new FakeTerminal();
  const instance = render(<Screen tail="thinking…" />, {
    stdout: term as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering,
    // Forced, not inferred. Ink treats CI as non-interactive and writes only
    // the final frame at unmount, so under CI every measurement here is 0 and
    // the incremental assertion passes for the wrong reason. The fake terminal
    // already decides what environment this is; this is the input it missed.
    interactive: true,
  });

  await new Promise((r) => setTimeout(r, 80));
  const before = term.frames.length;

  // The transition under investigation: the loading label becomes the reply.
  instance.rerender(<Screen tail="Here is the actual reply from the model" />);
  await new Promise((r) => setTimeout(r, 120));

  const written = term.frames.slice(before).join("");
  instance.unmount();

  return stripAnsi(written)
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

describe("a one-line change does not repaint the whole screen", () => {
  test("incremental rendering rewrites only what changed", async () => {
    const incremental = await linesRepaintedOnOneLineChange(true);

    // One changed line of content. Allowing a couple more leaves room for the
    // cursor bookkeeping Ink writes alongside it without letting a regression to
    // whole-screen repaints through.
    expect(incremental).toBeLessThanOrEqual(3);
  });

  test("the default path repaints nearly the whole frame — which is the bug", async () => {
    // Pinned so the fix is not silently undone by an Ink upgrade that changes
    // the default: if this stops being true, the reason to pass the flag has
    // gone away and this file should say so rather than quietly pass.
    const standard = await linesRepaintedOnOneLineChange(false);
    const incremental = await linesRepaintedOnOneLineChange(true);

    expect(standard).toBeGreaterThan(ROWS / 2);
    expect(incremental).toBeLessThan(standard);
  });

  test("every Ink root the CLI mounts asks for it", async () => {
    // Read rather than imported: index.tsx is a program, not a module — it
    // parses argv and opens the database on load. The measurements above prove
    // the option works; this proves it is actually passed, which is the half a
    // component test cannot see.
    const source = await Bun.file(new URL("./index.tsx", import.meta.url)).text();
    const mounts = source.match(/\brender\(\s*</g) ?? [];
    const asking = source.match(/incrementalRendering:\s*true/g) ?? [];

    expect(mounts.length).toBeGreaterThan(0);
    expect(asking.length).toBe(mounts.length);
  });
});

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { spinnerFrame, POKEBALL_FRAMES, GLYPH, MODE_GLYPH, PANEL_MARK } from "./theme.ts";

describe("the pokéball spinner", () => {
  test("cycles through every frame in order", () => {
    const seen = Array.from({ length: POKEBALL_FRAMES.length }, (_, i) => spinnerFrame(i));
    expect(seen).toEqual([...POKEBALL_FRAMES]);
  });

  test("wraps rather than running off the end", () => {
    expect(spinnerFrame(POKEBALL_FRAMES.length)).toBe(POKEBALL_FRAMES[0]!);
    expect(spinnerFrame(POKEBALL_FRAMES.length * 3 + 2)).toBe(POKEBALL_FRAMES[2]!);
  });

  test("a negative tick still lands on a real frame", () => {
    // A clock that ticks backwards must not index out of the array.
    expect(POKEBALL_FRAMES).toContain(spinnerFrame(-1) as never);
    expect(POKEBALL_FRAMES).toContain(spinnerFrame(-7) as never);
  });

  test("the seam actually moves — consecutive frames differ", () => {
    // Reusing a frame back to back would read as a blink, not a rotation.
    for (let i = 0; i < POKEBALL_FRAMES.length; i++) {
      expect(spinnerFrame(i)).not.toBe(spinnerFrame(i + 1));
    }
  });
});

describe("glyphs stay on the monospace grid", () => {
  const singleCell = (glyph: string) => [...glyph].length === 1;

  test("every single-character glyph really is one code point", () => {
    // An emoji here would be two cells wide in most terminals and would shift
    // every column after it — which is the whole reason these are text glyphs.
    for (const [name, glyph] of Object.entries(GLYPH)) {
      if (glyph.length <= 2) {
        expect(singleCell(glyph), `${name} is not one code point`).toBe(true);
      }
    }
    for (const frame of POKEBALL_FRAMES) expect(singleCell(frame)).toBe(true);
  });

  test("mode markers are all the same width, so the panel does not jitter", () => {
    const widths = new Set(Object.values(MODE_GLYPH).map((g) => [...g].length));
    expect(widths.size).toBe(1);
  });

  test("the panel mark is a rectangle", () => {
    const widths = new Set(PANEL_MARK.map((line) => [...line].length));
    expect(widths.size).toBe(1);
  });
});

describe("no emoji in the interface", () => {
  // Emoji render at inconsistent widths and carry their own colour, so they
  // ignore the palette. This keeps them from creeping back in one at a time.
  // Emoji_Presentation is the exact predicate: it matches what renders as a
  // wide colour glyph by default, and leaves single-cell text marks such as ❯,
  // ✓ and the box-drawing set alone — which is the distinction that matters.
  const EMOJI = /\p{Emoji_Presentation}|\uFE0F/u;

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
  }

  test("no source file under src/cli renders one", () => {
    const offenders: string[] = [];

    for (const file of walk(path.join(import.meta.dir))) {
      const source = fs.readFileSync(file, "utf8");
      source.split("\n").forEach((line, i) => {
        if (EMOJI.test(line)) offenders.push(`${path.basename(file)}:${i + 1} ${line.trim().slice(0, 60)}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});

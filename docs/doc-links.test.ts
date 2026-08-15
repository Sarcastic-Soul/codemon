import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

/**
 * The documentation, checked the way a new reader reads it: every local link
 * must land on a file that exists, and no page may name a module that was
 * renamed out of the tree.
 *
 * It lives in `docs/` rather than `src/` because docs are what it tests. The
 * architecture guide had spent a refactor pointing at `src/core/battle-engine.ts`,
 * `src/pokeball/`, `src/moves/` and `src/safari-zone/` — none of which exist —
 * through links hardcoded to one machine's home directory.
 */
const ROOT = path.resolve(import.meta.dir, "..");

const PAGES = [
  "README.md",
  ...fs.readdirSync(path.join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join("docs", f)),
];

/** Every markdown link target that is not an external URL or a bare anchor. */
function localLinks(page: string): string[] {
  const body = fs.readFileSync(path.join(ROOT, page), "utf8");
  return [...body.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!)
    .filter((href) => !/^(https?:|#|mailto:)/.test(href));
}

/** Names that were refactored away in commit 050d466, plus the two renamed since. */
const RETIRED = [
  "battle-engine",
  "src/pokeball/",
  "src/moves/",
  "src/safari-zone/",
  "pokedex.db",
  "spawn_party_member",
];

describe("documentation links", () => {
  for (const page of PAGES) {
    test(`${page} links to files that exist`, () => {
      const broken = localLinks(page).filter((href) => {
        const target = path.resolve(path.dirname(path.join(ROOT, page)), href.split("#")[0]!);
        return !fs.existsSync(target);
      });

      expect(broken).toEqual([]);
    });
  }

  test("no page links through an absolute file:// path", () => {
    // These resolved on exactly one machine and nowhere else.
    const offenders = PAGES.filter((page) =>
      fs.readFileSync(path.join(ROOT, page), "utf8").includes("file:///"),
    );

    expect(offenders).toEqual([]);
  });
});

describe("documentation names", () => {
  for (const page of PAGES) {
    test(`${page} names no retired module or file`, () => {
      const body = fs.readFileSync(path.join(ROOT, page), "utf8");
      const found = RETIRED.filter((name) => body.includes(name));

      expect(found).toEqual([]);
    });
  }
});

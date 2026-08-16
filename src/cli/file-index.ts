/**
 * The list of project paths `@` completes against.
 *
 * Built once per session and cached: the popup has to redraw on every keystroke,
 * so it cannot afford to touch the filesystem per character. `git ls-files` is
 * preferred because it already honours .gitignore; the hand-walk fallback exists
 * for a directory that is not a repository and prunes the same way rather than
 * enumerating node_modules.
 */
import * as fs from "fs";
import * as path from "path";
import type { Suggestion } from "./suggestions.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
]);

/** Enough to complete against without holding a pathological repo in memory. */
const MAX_ENTRIES = 8000;

let cache: { root: string; entries: Suggestion[] } | null = null;

function fromGit(root: string): string[] | null {
  try {
    // Tracked plus untracked-but-not-ignored, which is what a developer sees.
    const out = Bun.spawnSync({
      cmd: ["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
      stdout: "pipe",
      stderr: "ignore",
    });
    if (out.exitCode !== 0) return null;

    const files = new TextDecoder().decode(out.stdout).split("\n").filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

function fromWalk(root: string): string[] {
  const files: string[] = [];

  const walk = (dir: string, prefix: string) => {
    if (files.length >= MAX_ENTRIES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — nothing to complete from it
    }

    for (const entry of entries) {
      if (files.length >= MAX_ENTRIES) return;
      if (entry.name.startsWith(".")) continue;

      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (entry.isFile()) files.push(rel);
    }
  };

  walk(root, "");
  return files;
}

/**
 * Every completable path under `root` — files, plus the directories implied by
 * them so `@src/` can be narrowed before a filename is known. Directories sort
 * first and carry a trailing slash, which is also what tells `applyCompletion`
 * to leave the cursor attached.
 */
export function buildFileIndex(root: string): Suggestion[] {
  if (cache?.root === root) return cache.entries;

  const files = (fromGit(root) ?? fromWalk(root)).slice(0, MAX_ENTRIES);

  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      directories.add(`${parts.slice(0, i).join("/")}/`);
    }
  }

  const entries: Suggestion[] = [
    ...[...directories].sort().map((dir) => ({
      value: dir,
      label: dir,
      detail: "dir",
      kind: "file" as const,
    })),
    ...files.sort().map((file) => ({
      value: file,
      label: file,
      kind: "file" as const,
    })),
  ];

  cache = { root, entries };
  return entries;
}

/** Drops the memo so the next build re-reads. For tests and explicit refresh. */
export function resetFileIndex(): void {
  cache = null;
}

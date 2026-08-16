import * as fs from "fs";
import * as path from "path";
import { shellExecArgv } from "../sandbox/shell-executor.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "__pycache__", ".cache", "coverage"]);
const MAX_TREE_FILES = 150;

/** Build a compact ASCII tree of the project, skipping noise directories. */
function buildFileTree(dir: string, depth = 0, maxDepth = 4, count = { n: 0 }): string {
  if (depth > maxDepth || count.n >= MAX_TREE_FILES) return "";
  const indent = "  ".repeat(depth);
  let result = "";

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }

  // Dirs first, then files, alphabetical
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (count.n >= MAX_TREE_FILES) {
      result += `${indent}… (truncated)\n`;
      break;
    }
    if (entry.name.startsWith(".") && entry.name !== ".gitignore" && entry.name !== ".env.example") continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      result += `${indent}${entry.name}/ (skipped)\n`;
      continue;
    }
    if (entry.isDirectory()) {
      result += `${indent}${entry.name}/\n`;
      result += buildFileTree(path.join(dir, entry.name), depth + 1, maxDepth, count);
    } else {
      count.n++;
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(0)}KB`;
      result += `${indent}${entry.name} (${size})\n`;
    }
  }
  return result;
}

/** Most files the mtime fallback will stat before giving up on being exhaustive. */
const MAX_WALK_FILES = 20_000;

/**
 * Recently modified files via git, falling back to mtime if no git repo. Both
 * paths stay out of the shell so a `projectRoot` with quotes in it still works.
 */
async function getRecentlyModified(projectRoot: string, n = 10): Promise<string[]> {
  const gitResult = await shellExecArgv(
    ["git", "-C", projectRoot, "log", "--name-only", "--pretty=format:", `-${n * 2}`],
    5000,
  );
  if (gitResult.exitCode === 0 && gitResult.stdout.trim()) {
    const files = gitResult.stdout.split("\n").filter((line) => line.trim() !== "");
    if (files.length > 0) return [...new Set(files)].slice(0, n);
  }

  return mostRecentlyModified(projectRoot, n);
}

/**
 * Newest files by mtime, for a directory that is not a git repository. Walks by
 * hand rather than globbing so `node_modules` is pruned, not enumerated.
 */
function mostRecentlyModified(projectRoot: string, n: number): string[] {
  const found: Array<{ file: string; mtimeMs: number }> = [];

  const walk = (dir: string) => {
    if (found.length >= MAX_WALK_FILES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — nothing to report about it
    }

    for (const entry of entries) {
      if (found.length >= MAX_WALK_FILES) return;
      if (entry.name.startsWith(".")) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks, sockets, devices

      try {
        found.push({ file: path.relative(projectRoot, full), mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        continue; // vanished between the walk and the stat
      }
    }
  };

  walk(projectRoot);

  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, n)
    .map((entry) => entry.file);
}

/** Get git status summary. */
async function getGitStatus(projectRoot: string): Promise<string> {
  const result = await shellExecArgv(["git", "-C", projectRoot, "status", "--short"], 5000);
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim().split("\n").slice(0, 15).join("\n");
  }
  return "";
}

/** Detect tech stack from package.json / pyproject.toml / go.mod etc. */
function detectStack(projectRoot: string): string[] {
  const markers: string[] = [];
  const check = (file: string, label: string) => {
    if (fs.existsSync(path.join(projectRoot, file))) markers.push(label);
  };

  check("package.json", "Node/TypeScript");
  check("bun.lockb", "Bun");
  check("pnpm-lock.yaml", "pnpm");
  check("yarn.lock", "Yarn");
  check("pyproject.toml", "Python");
  check("requirements.txt", "Python");
  check("go.mod", "Go");
  check("Cargo.toml", "Rust");
  check("Gemfile", "Ruby");
  check("pom.xml", "Java/Maven");
  check("build.gradle", "Java/Gradle");
  check("Dockerfile", "Docker");
  check("docker-compose.yml", "Docker Compose");
  check(".github/workflows", "GitHub Actions");
  check("tsconfig.json", "TypeScript");
  return markers;
}

export interface RepoIndex {
  projectName: string;
  stack: string[];
  fileTree: string;
  recentFiles: string[];
  gitStatus: string;
}

/** Build the full project index to inject into the system prompt. */
export async function buildRepoIndex(projectRoot: string): Promise<RepoIndex> {
  const projectName = path.basename(projectRoot);
  const stack = detectStack(projectRoot);
  const fileTree = buildFileTree(projectRoot);
  const [recentFiles, gitStatus] = await Promise.all([
    getRecentlyModified(projectRoot),
    getGitStatus(projectRoot),
  ]);
  return { projectName, stack, fileTree, recentFiles, gitStatus };
}

/** Format the repo index as a system-prompt section. */
export function formatRepoIndex(index: RepoIndex): string {
  const parts: string[] = [
    `## Project: ${index.projectName}`,
  ];

  if (index.stack.length > 0) {
    parts.push(`**Stack**: ${index.stack.join(", ")}`);
  }

  parts.push(`\n### File Tree\n\`\`\`\n${index.fileTree.trim()}\n\`\`\``);

  if (index.recentFiles.length > 0) {
    parts.push(`\n### Recently Modified\n${index.recentFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (index.gitStatus) {
    parts.push(`\n### Git Status\n\`\`\`\n${index.gitStatus}\n\`\`\``);
  }

  return parts.join("\n");
}

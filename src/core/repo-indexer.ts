import * as fs from "fs";
import * as path from "path";
import { shellExec } from "../safari-zone/shell-executor.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "__pycache__", ".cache", "coverage"]);
const MAX_TREE_FILES = 150;

/**
 * Build a compact ASCII tree of the project, skipping common noise directories.
 */
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

/**
 * Get recently modified files via git (falls back to find if no git repo).
 */
async function getRecentlyModified(projectRoot: string, n = 10): Promise<string[]> {
  // Try git
  const gitResult = await shellExec(
    `git -C '${projectRoot}' log --name-only --pretty=format: -${n * 2} 2>/dev/null | grep -v '^$' | head -${n}`,
    5000,
  );
  if (gitResult.exitCode === 0 && gitResult.stdout.trim()) {
    return [...new Set(gitResult.stdout.trim().split("\n").filter(Boolean))].slice(0, n);
  }

  // Fallback: find most recently modified files
  const findResult = await shellExec(
    `find '${projectRoot}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -${n} | awk '{print $2}'`,
    5000,
  );
  if (findResult.exitCode === 0) {
    return findResult.stdout.trim().split("\n").filter(Boolean).map((p) => path.relative(projectRoot, p));
  }
  return [];
}

/**
 * Get git status summary.
 */
async function getGitStatus(projectRoot: string): Promise<string> {
  const result = await shellExec(`git -C '${projectRoot}' status --short 2>/dev/null`, 5000);
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim().split("\n").slice(0, 15).join("\n");
  }
  return "";
}

/**
 * Detect tech stack from package.json / pyproject.toml / go.mod etc.
 */
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

/**
 * Build the full project index to inject into the system prompt.
 */
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

/**
 * Format the repo index as a system-prompt section.
 */
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

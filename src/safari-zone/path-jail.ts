import * as path from "path";

/**
 * Path Jail — prevents file operations from escaping the project root.
 * All file-access moves must validate paths through this module.
 */

let projectRoot: string = process.cwd();

export function setProjectRoot(root: string) {
  projectRoot = path.resolve(root);
}

export function getProjectRoot(): string {
  return projectRoot;
}

/**
 * Resolves a path and asserts it is within the project root.
 * Throws if the resolved path escapes the jail.
 */
export function jailPath(filePath: string): string {
  const resolved = path.resolve(projectRoot, filePath);
  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    throw new Error(
      `🔒 Poké Ball blocked: path "${filePath}" escapes the project root.\n` +
        `  Project root: ${projectRoot}\n` +
        `  Resolved to: ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Returns true if the path is within the jail (non-throwing variant).
 */
export function isInsideJail(filePath: string): boolean {
  try {
    jailPath(filePath);
    return true;
  } catch {
    return false;
  }
}

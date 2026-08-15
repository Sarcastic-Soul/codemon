import * as fs from "fs";
import * as path from "path";

/**
 * Path Jail — prevents file operations from escaping the project root.
 * All file-access moves must validate paths through this module.
 */

let projectRoot: string = path.resolve(process.cwd());
let realProjectRoot: string = resolveThroughSymlinks(projectRoot);

export function setProjectRoot(root: string) {
  projectRoot = path.resolve(root);
  realProjectRoot = resolveThroughSymlinks(projectRoot);
}

export function getProjectRoot(): string {
  return projectRoot;
}

/**
 * `fs.realpathSync` for a path that may not exist yet.
 *
 * Resolves the deepest ancestor that does exist and re-attaches the rest, so a
 * file about to be created is still judged against the real location of the
 * directory it would land in. Falls back to the input when nothing on the path
 * exists at all.
 */
function resolveThroughSymlinks(target: string): string {
  const trailing: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return trailing.length > 0 ? path.join(real, ...trailing) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target; // hit the filesystem root
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Resolves a path and asserts it is within the project root.
 * Throws if the resolved path escapes the jail.
 *
 * Comparison happens on symlink-resolved paths: a link inside the project that
 * points outside it resolves to an in-root string and would otherwise pass. The
 * value returned is the plain resolved path, since that is what callers pass to
 * `fs` and it reaches the same file.
 */
export function jailPath(filePath: string): string {
  const resolved = path.resolve(projectRoot, filePath);
  const real = resolveThroughSymlinks(resolved);

  if (!isWithin(real, realProjectRoot)) {
    throw new Error(
      `🔒 Access denied: path "${filePath}" escapes the project root.\n` +
        `  Project root: ${projectRoot}\n` +
        `  Resolved to: ${real === resolved ? resolved : `${resolved} → ${real}`}`,
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

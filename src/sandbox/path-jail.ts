import * as fs from "fs";
import * as path from "path";

/**
 * Path Jail — prevents file operations from escaping the project root. All
 * file-access moves must validate paths through this module.
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
 * `fs.realpathSync` for a path that may not exist yet: resolves the deepest
 * existing ancestor and re-attaches the rest.
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
 * Resolves a path and throws if it escapes the jail. Compared on symlink-resolved
 * paths, since a link inside the project can point outside it.
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

/** Returns true if the path is within the jail (non-throwing variant). */
export function isInsideJail(filePath: string): boolean {
  try {
    jailPath(filePath);
    return true;
  } catch {
    return false;
  }
}

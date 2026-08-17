/**
 * Which shell commands plan mode lets through.
 *
 * Blunt on purpose: any shell metacharacter denies outright, with no attempt to
 * allow the safe half of a pipeline. `git log | tee evil.txt` is a write, and a
 * hole here is a silent write during a pass the user was told was read-only.
 *
 * An allowlist, not a sandbox — it narrows what plan mode permits and never
 * widens what the permission mode already allows.
 */

/** Commands that only read. Everything not here is denied. */
const READ_ONLY_COMMANDS = new Set([
  "git", "ls", "cat", "head", "tail", "wc", "rg", "grep", "find",
  "pwd", "which", "file", "stat", "tree", "du", "diff",
]);

/** git subcommands that only read. `git` on its own is far too broad. */
const READ_ONLY_GIT = new Set([
  "log", "status", "diff", "show", "branch", "blame", "ls-files", "remote",
]);

/**
 * Characters that chain, redirect or substitute. Their presence means the
 * string is no longer one command, and one command is all this can reason about.
 */
const METACHARACTERS = ["|", "&", ";", ">", "<", "`", "$(", "${", "\n", "\r"];

/**
 * Flags that turn a reader into a writer. `git diff --output=x` writes a file
 * despite `diff` being on the read-only list, so these deny anywhere in argv.
 */
const WRITING_FLAGS = ["--output", "-o", "--out"];

export interface AllowlistVerdict {
  allowed: boolean;
  /** Why not, phrased for the model so it stops retrying variations. */
  reason?: string;
}

/** Whether plan mode permits this shell command. */
export function isReadOnlyCommand(command: string): AllowlistVerdict {
  const trimmed = command.trim();
  if (trimmed === "") return { allowed: false, reason: "empty command" };

  for (const meta of METACHARACTERS) {
    if (trimmed.includes(meta)) {
      return {
        allowed: false,
        reason:
          `shell metacharacter "${meta === "\n" ? "\\n" : meta}" is not allowed in plan mode — ` +
          `run a single command with no pipes, redirects or substitutions`,
      };
    }
  }

  const argv = trimmed.split(/\s+/);
  const head = argv[0]!;

  if (!READ_ONLY_COMMANDS.has(head)) {
    return {
      allowed: false,
      reason:
        `"${head}" is not a read-only command. Plan mode allows: ` +
        `${[...READ_ONLY_COMMANDS].sort().join(", ")}`,
    };
  }

  if (head === "git") {
    const sub = argv.find((a, i) => i > 0 && !a.startsWith("-"));
    if (!sub || !READ_ONLY_GIT.has(sub)) {
      return {
        allowed: false,
        reason:
          `git ${sub ?? "(no subcommand)"} is not read-only. Plan mode allows: ` +
          `${[...READ_ONLY_GIT].sort().map((s) => `git ${s}`).join(", ")}`,
      };
    }
  }

  for (const arg of argv.slice(1)) {
    const flag = arg.split("=")[0]!;
    if (WRITING_FLAGS.includes(flag)) {
      return { allowed: false, reason: `"${flag}" writes a file, which plan mode does not allow` };
    }
  }

  return { allowed: true };
}

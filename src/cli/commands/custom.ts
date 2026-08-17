/**
 * User-defined slash commands: markdown files that expand into prompts.
 *
 * A file at `.codemon/commands/review.md` becomes `/review`, and running it
 * submits the body as an ordinary user turn. Optional YAML-ish frontmatter sets
 * the description and the side-panel hint:
 *
 *   ---
 *   description: Review the current diff for bugs
 *   hint: review diff
 *   ---
 *   Run `git diff` and review every change for correctness bugs.
 *   Focus on: $ARGUMENTS
 */
import * as fs from "fs";
import * as path from "path";
import { registerCommand, type SlashCommand } from "./index.ts";
import { getUserConfigDir } from "../../config/paths.ts";
import { logger } from "../../utils/logger.ts";

/** Where the arguments go, if the body says so. */
const ARGUMENTS_TOKEN = "$ARGUMENTS";

export interface ParsedCommandFile {
  description: string;
  hint: string;
  body: string;
}

/**
 * Split frontmatter from body.
 *
 * Deliberately not a YAML parser — this is `key: value` and nothing else. A
 * malformed block is treated as body text rather than an error: a command that
 * runs with a generic description beats one that refuses to load because a
 * colon was in the wrong place.
 */
export function parseCommandFile(source: string, name: string): ParsedCommandFile {
  const meta: Record<string, string> = {};
  let body = source;

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (match) {
    body = source.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      const sep = line.indexOf(":");
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim().toLowerCase();
      const value = line.slice(sep + 1).trim();
      if (key) meta[key] = value;
    }
  }

  body = body.trim();

  // Falling back to the first line keeps a frontmatter-free file usable —
  // /help still has something to show next to the name.
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
  const description = meta.description || firstLine.slice(0, 70) || `Custom command: /${name}`;

  return {
    description,
    hint: meta.hint || name.slice(0, 14),
    body,
  };
}

/**
 * Substitute the arguments into a command body.
 *
 * When the body has no `$ARGUMENTS`, they are appended on their own line rather
 * than dropped — a user who typed them meant them, and silently discarding
 * them makes the command look broken.
 */
export function expandArguments(body: string, args: string): string {
  if (body.includes(ARGUMENTS_TOKEN)) {
    return body.split(ARGUMENTS_TOKEN).join(args);
  }
  return args ? `${body}\n\n${args}` : body;
}

function commandFromFile(filePath: string): SlashCommand | null {
  const name = path.basename(filePath, ".md").trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null;

  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const { description, hint, body } = parseCommandFile(source, name);
  if (body === "") return null;

  return {
    names: [`/${name}`],
    description,
    hint,
    execute(_ctx, args) {
      return { submit: expandArguments(body, args) };
    },
  };
}

function loadDirectory(dir: string): SlashCommand[] {
  let entries: string[];
  try {
    if (!fs.existsSync(dir)) return [];
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const found: SlashCommand[] = [];
  for (const entry of entries.sort()) {
    const cmd = commandFromFile(path.join(dir, entry));
    if (cmd) found.push(cmd);
  }
  return found;
}

export interface CustomCommandLoad {
  loaded: string[];
  /** Names rejected for colliding with a built-in. */
  skipped: string[];
}

/**
 * Discover and register user commands. User-level first, project second, so a
 * project file of the same name replaces the user's — `registerCommand` treats
 * a later registration as an override.
 *
 * Called once at startup: `commandSuggestions()` and `/help` both read the
 * registry live, so `/` completion picks these up with no further wiring.
 */
export function loadCustomCommands(projectRoot: string): CustomCommandLoad {
  const dirs = [
    path.join(getUserConfigDir(), "commands"),
    path.join(projectRoot, ".codemon", "commands"),
  ];

  const loaded: string[] = [];
  const skipped: string[] = [];

  for (const dir of dirs) {
    for (const cmd of loadDirectory(dir)) {
      if (registerCommand(cmd)) {
        loaded.push(cmd.names[0]!);
      } else {
        // Built-ins always win. A file that quietly stopped /exit from exiting
        // is a far worse surprise than one that refuses to load.
        skipped.push(cmd.names[0]!);
        logger.warn("custom command shadows a built-in — skipped", { name: cmd.names[0]! });
      }
    }
  }

  return { loaded, skipped };
}

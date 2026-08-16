/**
 * CLI argument parsing, kept out of index.tsx so it can be exercised without
 * booting the TUI. Every flag declares whether it takes a value, so a missing
 * one becomes a message and a non-zero exit rather than a boolean downstream.
 */
import { PERMISSION_MODES, isPermissionMode } from "../permissions/rules.ts";
import { SANDBOX_MODES, isSandboxMode } from "../config/defaults.ts";
import { ALL_COMMANDS } from "./commands/index.ts";

export type FlagValue = string | true;

export interface ParsedArgs {
  flags: Record<string, FlagValue>;
  positional: string[];
}

export type ParseResult =
  | { ok: true; args: ParsedArgs }
  | { ok: false; error: string };

/** Flags that must be followed by a value: `--flag value` or `--flag=value`. */
const VALUE_FLAGS = ["region", "mode", "model", "sandbox"] as const;

/** Flags whose value is optional — `--audit` and `--audit <id>` are both valid. */
const OPTIONAL_VALUE_FLAGS = ["audit"] as const;

/** Flags that never take a value. */
const BOOLEAN_FLAGS = [
  "help",
  "h",
  "debug",
  "no-index",
  "continue",
  "rewind",
  "sessions",
  "eval",
] as const;

const KNOWN_FLAGS = new Set<string>([
  ...VALUE_FLAGS,
  ...OPTIONAL_VALUE_FLAGS,
  ...BOOLEAN_FLAGS,
]);

const MODE_LIST = PERMISSION_MODES.join(" | ");
const SANDBOX_LIST = SANDBOX_MODES.join(" | ");

/**
 * The slash-command block, generated from the registry the TUI dispatches
 * against, so `--help` and the TUI cannot drift apart.
 */
const SLASH_COMMANDS = ALL_COMMANDS.map(
  (cmd) => `  ${cmd.names.join(", ").padEnd(20)}  ${cmd.description}`,
).join("\n");

export const USAGE = `
CODEMON — Your AI Coding Partner

Usage: codemon [options]

Options:
  --region <path>       Project root directory (default: cwd)
  --mode <mode>         Permission mode: ${MODE_LIST} (default: standard)
  --model <model>       Model: provider:model-name  (e.g. anthropic:claude-sonnet-5)
  --sandbox <mode>      Sandbox mode: ${SANDBOX_LIST}  (default: subprocess)
  --no-index            Skip repo indexing on startup
  --continue            Resume the most recent session for this region
  --rewind              Restore all files to their state before the last session
  --sessions            List recent sessions for this region
  --audit [id]          Show permission decisions for a session (default: most recent)
  --eval                Run the automated eval suite
  --debug               Enable debug logging to ~/.codemon/debug.log
  --help                Show this help

  A flag taking a value accepts either form: --model x or --model=x. Use the
  --flag=value form for a value that starts with a dash.

Configuration (highest precedence wins):
  1. the flags above
  2. CODEMON_MODEL environment variable
  3. <project>/.codemon/config.json     project-local, gitignored
  4. <project>/codemon.json             committed with the repo
  5. ~/.codemon/config.json             user-level; /connector writes "defaultModel" here
  6. built-in defaults

TUI Slash Commands (type while in interactive mode):
${SLASH_COMMANDS}
  Ctrl+C also exits.

Providers (BYOK):
  ~185 providers come from the models.dev catalog, refreshed in the background.
  Run /connector in the TUI to browse, filter and store a key for any of them.

  google      GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY
  anthropic   ANTHROPIC_API_KEY
  openai      OPENAI_API_KEY
  openrouter  OPENROUTER_API_KEY   one key, hundreds of models
  vercel      AI_GATEWAY_API_KEY   Vercel AI Gateway, same idea

  Local runtimes (Ollama, vLLM, LM Studio) go under "providers" in
  ~/.codemon/config.json — see docs/cli-commands.md.

Examples:
  codemon                                        # Start with default model
  codemon --model anthropic:claude-sonnet-5      # Use Claude
  codemon --continue                             # Resume last session
  codemon --rewind                               # Restore files from last session
  codemon --sandbox docker --mode yolo           # Docker sandbox, auto-approve all
  codemon --eval                                 # Run benchmark eval suite
  `;

/** Flags a typo is most likely aiming at, so the error can suggest one. */
function nearestFlag(unknown: string): string | undefined {
  const candidates = [...KNOWN_FLAGS];
  const prefix = candidates.find((f) => f.startsWith(unknown) || unknown.startsWith(f));
  if (prefix) return prefix;
  // Same letters, wrong order or one typo apart: cheap enough to be worth it.
  const sorted = (s: string) => [...s].sort().join("");
  return candidates.find((f) => sorted(f) === sorted(unknown));
}

function validate(flags: Record<string, FlagValue>): string | null {
  if (flags.mode !== undefined && !isPermissionMode(flags.mode)) {
    return `Unknown permission mode: "${String(flags.mode)}" — expected one of: ${MODE_LIST}`;
  }
  if (flags.sandbox !== undefined && !isSandboxMode(flags.sandbox)) {
    return `Unknown sandbox mode: "${String(flags.sandbox)}" — expected one of: ${SANDBOX_LIST}`;
  }
  if (typeof flags.model === "string" && flags.model.trim() === "") {
    return "--model needs a value — no value given.";
  }
  if (typeof flags.region === "string" && flags.region.trim() === "") {
    return "--region needs a value — no value given.";
  }
  return null;
}

export function parseArgs(argv: string[]): ParseResult {
  const flags: Record<string, FlagValue> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    // The one short flag the docs promise. Everything else is `--long`.
    if (arg === "-h") {
      flags.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);

    if (!KNOWN_FLAGS.has(key)) {
      const suggestion = nearestFlag(key);
      return {
        ok: false,
        error:
          `Unknown option: --${key}` +
          (suggestion ? ` — did you mean --${suggestion}?` : ""),
      };
    }

    const takesValue = !(BOOLEAN_FLAGS as readonly string[]).includes(key);

    if (inline !== undefined) {
      if (!takesValue) return { ok: false, error: `--${key} does not take a value.` };
      if (inline === "") return { ok: false, error: `--${key} needs a value — no value given.` };
      flags[key] = inline;
      continue;
    }

    if (!takesValue) {
      flags[key] = true;
      continue;
    }

    // A value may start with a single dash; only a `--flag` token ends the
    // value slot, and `--flag=-value` covers the rest.
    const next = argv[i + 1];
    if (next !== undefined && next !== "--" && !next.startsWith("--")) {
      flags[key] = next;
      i++;
      continue;
    }

    if ((OPTIONAL_VALUE_FLAGS as readonly string[]).includes(key)) {
      flags[key] = true;
      continue;
    }

    return { ok: false, error: `--${key} needs a value — no value given.` };
  }

  const invalid = validate(flags);
  if (invalid) return { ok: false, error: invalid };

  return { ok: true, args: { flags, positional } };
}

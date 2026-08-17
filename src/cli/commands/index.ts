/**
 * Slash command registry and dispatcher. To add one, create
 * src/cli/commands/<name>.ts and add its export to BUILTIN_COMMANDS below.
 *
 * Commands may be async and may hand work back to the caller rather than doing
 * everything themselves — see `CommandResult`. That is what lets `/init` and a
 * user-defined command expand into an ordinary agent turn without this module
 * knowing anything about the agent loop.
 */

import type { Dispatch, SetStateAction } from "react";
import type { Provider } from "../../providers/types.ts";
import type { CodemonConfig } from "../../config/defaults.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * What a command hands back.
 *
 * `void` means it did everything itself (it can call `ctx.addMessage`).
 * `{ submit }` asks the caller to run that text as a normal user turn.
 * `{ notice }` is a one-line message with no agent turn — the same thing
 * `addMessage` does, but available to commands that never touch React state.
 */
export type CommandResult =
  | void
  | { submit: string }
  | { notice: string };

/** The shared context object passed to every command handler */
export interface CommandContext {
  exit: () => void;
  addMessage: (msg: ChatMessage) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setShowConnectorModal: Dispatch<SetStateAction<boolean>>;
  /** Undefined until an API key is configured — `/compact` has to check. */
  provider?: Provider;
  config: CodemonConfig;
  projectRoot: string;
  /** Plan mode as it stands now, so a toggle knows which way to go. */
  planMode: boolean;
  setPlanMode: (on: boolean) => void;
}

export interface SlashCommand {
  /** All aliases that trigger this command (first is the canonical name) */
  names: string[];
  /** Short description shown in /help and in `codemon --help` */
  description: string;
  /** Two-or-three-word form for the side panel, which has ~15 columns for it */
  hint: string;
  /** Everything after the command token arrives as `args`, trimmed. */
  execute(ctx: CommandContext, args: string): CommandResult | Promise<CommandResult>;
}

import { exitCommand } from "./exit.ts";
import { connectorCommand } from "./connector.ts";
import { helpCommand } from "./help.ts";
import { clearCommand } from "./clear.ts";
import { compactCommand } from "./compact.ts";
import { planCommand } from "./plan.ts";
import { initCommand } from "./init.ts";

/**
 * Commands compiled into the binary. Kept separate from `ALL_COMMANDS` because
 * a project-local markdown file must never be able to redefine `/exit`.
 */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  exitCommand,
  connectorCommand,
  helpCommand,
  clearCommand,
  compactCommand,
  planCommand,
  initCommand,
];

/**
 * Every command currently dispatchable, built-ins plus anything registered at
 * startup from `.codemon/commands/`. Mutated in place rather than replaced so
 * `commandSuggestions()` and `/help` pick up registrations without re-importing.
 */
export const ALL_COMMANDS: SlashCommand[] = [...BUILTIN_COMMANDS];

/** Every name and alias a built-in answers to, lowercased. */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_COMMANDS.flatMap((cmd) => cmd.names.map((n) => n.toLowerCase())),
);

// Flat lookup map: "/exit" → exitCommand, "/quit" → exitCommand, etc.
const commandMap = new Map<string, SlashCommand>();
function index(cmd: SlashCommand): void {
  for (const name of cmd.names) commandMap.set(name.toLowerCase(), cmd);
}
for (const cmd of ALL_COMMANDS) index(cmd);

/**
 * Add a command discovered at runtime. Returns false when the name collides
 * with a built-in — a custom `/exit` that quietly stopped exiting would be a
 * far worse surprise than one that refuses to load.
 */
export function registerCommand(cmd: SlashCommand): boolean {
  if (cmd.names.some((n) => BUILTIN_NAMES.has(n.toLowerCase()))) return false;

  // A later registration of the same name replaces the earlier one, which is
  // how a project command overrides a user-level one of the same name.
  const existing = ALL_COMMANDS.findIndex((c) =>
    c.names.some((n) => cmd.names.includes(n)),
  );
  if (existing >= 0) ALL_COMMANDS.splice(existing, 1);

  ALL_COMMANDS.push(cmd);
  index(cmd);
  return true;
}

export interface DispatchResult {
  /** False when the input was not a known command at all. */
  matched: boolean;
  result?: CommandResult;
}

/**
 * Split `/cmd rest of the line` into its token and its arguments.
 *
 * The token is lowercased for lookup; the arguments emphatically are not —
 * they can be a file path or a sentence for the model.
 */
export function splitCommand(input: string): { token: string; args: string } {
  const trimmed = input.trim();
  const space = trimmed.search(/\s/);
  return space === -1
    ? { token: trimmed.toLowerCase(), args: "" }
    : { token: trimmed.slice(0, space).toLowerCase(), args: trimmed.slice(space + 1).trim() };
}

/** Dispatch a slash command. `matched` is false if the input matched none. */
export async function dispatchCommand(
  input: string,
  ctx: CommandContext,
): Promise<DispatchResult> {
  const { token, args } = splitCommand(input);

  const cmd = commandMap.get(token);
  if (!cmd) return { matched: false };

  const result = await cmd.execute(ctx, args);
  return { matched: true, result };
}

/**
 * Slash command registry and dispatcher. To add one, create
 * src/cli/commands/<name>.ts and add its export to ALL_COMMANDS below.
 */

import type { Dispatch, SetStateAction } from "react";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The shared context object passed to every command handler */
export interface CommandContext {
  exit: () => void;
  addMessage: (msg: ChatMessage) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setShowConnectorModal: Dispatch<SetStateAction<boolean>>;
}

export interface SlashCommand {
  /** All aliases that trigger this command (first is the canonical name) */
  names: string[];
  /** Short description shown in /help and in `codemon --help` */
  description: string;
  /** Two-or-three-word form for the side panel, which has ~15 columns for it */
  hint: string;
  execute(ctx: CommandContext): void;
}

import { exitCommand } from "./exit.ts";
import { connectorCommand } from "./connector.ts";
import { helpCommand } from "./help.ts";
import { clearCommand } from "./clear.ts";

/** Registry of all available slash commands */
export const ALL_COMMANDS: SlashCommand[] = [
  exitCommand,
  connectorCommand,
  helpCommand,
  clearCommand,
];

// Build a flat lookup map: "/exit" → exitCommand, "/quit" → exitCommand, etc.
const commandMap = new Map<string, SlashCommand>();
for (const cmd of ALL_COMMANDS) {
  for (const name of cmd.names) {
    commandMap.set(name.toLowerCase(), cmd);
  }
}

/** Dispatch a slash command. Returns true if the input matched one. */
export function dispatchCommand(input: string, ctx: CommandContext): boolean {
  const trimmed = input.trim().toLowerCase();

  // Extract the first "word" token to match commands like "/connector google"
  const token = trimmed.split(/\s+/)[0] ?? trimmed;

  const cmd = commandMap.get(token);
  if (!cmd) return false;

  cmd.execute(ctx);
  return true;
}

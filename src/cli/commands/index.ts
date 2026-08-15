/**
 * Slash Command Registry & Dispatcher
 *
 * To add a new command:
 *   1. Create src/cli/commands/<name>.ts exporting a command object
 *   2. Import and add it to ALL_COMMANDS below
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
  /** Short description shown in /help */
  description: string;
  execute(ctx: CommandContext): void;
}

// ─── Import individual command modules ────────────────────────────────────────

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

/**
 * Attempt to dispatch a slash command.
 * Returns true if the input matched a command, false otherwise.
 */
export function dispatchCommand(input: string, ctx: CommandContext): boolean {
  const trimmed = input.trim().toLowerCase();

  // Extract the first "word" token to match commands like "/connector google"
  const token = trimmed.split(/\s+/)[0] ?? trimmed;

  const cmd = commandMap.get(token);
  if (!cmd) return false;

  cmd.execute(ctx);
  return true;
}

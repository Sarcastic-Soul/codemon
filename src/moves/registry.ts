import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { zodSchema } from "ai";
import { readFileMove } from "./read-file.ts";
import { writeFileMove } from "./write-file.ts";
import { editFileMove } from "./edit-file.ts";
import { listDirMove } from "./list-dir.ts";
import { bashMove } from "./bash.ts";
import { grepMove } from "./grep.ts";
import { globMove } from "./glob.ts";
import { spawnPartyMemberMove } from "./spawn-party-member.ts";

import type { PermissionLevel, MoveDefinition } from "./types.ts";
export type { PermissionLevel, MoveDefinition };

// Central registry
const moves: MoveDefinition[] = [
  readFileMove as MoveDefinition,
  writeFileMove as MoveDefinition,
  editFileMove as MoveDefinition,
  listDirMove as MoveDefinition,
  bashMove as MoveDefinition,
  grepMove as MoveDefinition,
  globMove as MoveDefinition,
  spawnPartyMemberMove as MoveDefinition,
];

export const moveRegistry = new Map<string, MoveDefinition>(
  moves.map((m) => [m.name, m]),
);

/**
 * Converts the move registry into Vercel AI SDK v7-compatible tool definitions.
 * AI SDK v7 uses `inputSchema` (not `parameters`).
 */
export function buildToolSet(): ToolSet {
  const tools: ToolSet = {};
  for (const move of moves) {
    tools[move.name] = tool({
      description: move.description,
      inputSchema: zodSchema(move.parameters),
      // execute is intentionally omitted — BattleEngine routes through the Poké Ball first
    });
  }
  return tools;
}

export function getMove(name: string): MoveDefinition | undefined {
  return moveRegistry.get(name);
}

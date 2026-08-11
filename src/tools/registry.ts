import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { zodSchema } from "ai";
import { readFileTool } from "./read-file.ts";
import { writeFileTool } from "./write-file.ts";
import { editFileTool } from "./edit-file.ts";
import { listDirTool } from "./list-dir.ts";
import { bashTool } from "./bash.ts";
import { grepTool } from "./grep.ts";
import { globTool } from "./glob.ts";
import { spawnSubagentTool } from "./spawn-subagent.ts";

import type { PermissionLevel, ToolDefinition } from "./types.ts";
export type { PermissionLevel, ToolDefinition };

// Central tool registry
const tools: ToolDefinition[] = [
  readFileTool as ToolDefinition,
  writeFileTool as ToolDefinition,
  editFileTool as ToolDefinition,
  listDirTool as ToolDefinition,
  bashTool as ToolDefinition,
  grepTool as ToolDefinition,
  globTool as ToolDefinition,
  spawnSubagentTool as ToolDefinition,
];

export const toolRegistry = new Map<string, ToolDefinition>(
  tools.map((t) => [t.name, t]),
);

/**
 * Converts the tool registry into Vercel AI SDK v7-compatible tool definitions.
 * AI SDK v7 uses `inputSchema` (not `parameters`).
 */
export function buildToolSet(): ToolSet {
  const toolSet: ToolSet = {};
  for (const t of tools) {
    toolSet[t.name] = tool({
      description: t.description,
      inputSchema: zodSchema(t.parameters),
      // execute is intentionally omitted — the agent loop routes through the permission gate first
    });
  }
  return toolSet;
}

export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry.get(name);
}

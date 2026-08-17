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
import { todoTool } from "./todo.ts";
import { webFetchTool } from "./web-fetch.ts";

import type { PermissionLevel, ToolDefinition } from "./types.ts";
export type { PermissionLevel, ToolDefinition };

/** Tools compiled into the binary. Anything else arrives through `registerTool`. */
const builtinTools: ToolDefinition[] = [
  readFileTool as ToolDefinition,
  writeFileTool as ToolDefinition,
  editFileTool as ToolDefinition,
  listDirTool as ToolDefinition,
  bashTool as ToolDefinition,
  grepTool as ToolDefinition,
  globTool as ToolDefinition,
  spawnSubagentTool as ToolDefinition,
  todoTool as ToolDefinition,
  webFetchTool as ToolDefinition,
];

export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(builtinTools.map((t) => t.name));

/**
 * The live registry.
 *
 * A Map rather than the const array it used to be, because MCP servers finish
 * their handshake after startup and register their tools then. `buildToolSet`
 * runs once per agent turn, so a server that comes up late is simply offered on
 * the next turn — no restart.
 */
export const toolRegistry = new Map<string, ToolDefinition>(
  builtinTools.map((t) => [t.name, t]),
);

/**
 * Add a tool at runtime. Refuses to shadow a built-in: a remote server that
 * could redefine `bash` would be a permission bypass wearing a familiar name.
 * Returns false if it was rejected.
 */
export function registerTool(def: ToolDefinition): boolean {
  if (BUILTIN_TOOL_NAMES.has(def.name)) return false;
  toolRegistry.set(def.name, def);
  return true;
}

/** Drop every registered tool whose name starts with `prefix` (MCP teardown). */
export function unregisterToolsByPrefix(prefix: string): number {
  let removed = 0;
  for (const name of [...toolRegistry.keys()]) {
    if (name.startsWith(prefix) && !BUILTIN_TOOL_NAMES.has(name)) {
      toolRegistry.delete(name);
      removed++;
    }
  }
  return removed;
}

/** Converts the tool registry into AI SDK v7 tool definitions. */
export function buildToolSet(): ToolSet {
  const toolSet: ToolSet = {};
  for (const t of toolRegistry.values()) {
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

/** Every tool currently callable, in registration order. */
export function listToolNames(): string[] {
  return [...toolRegistry.keys()];
}

/**
 * MCP lifecycle: start the declared servers, register their tools, shut them
 * down on exit.
 *
 * Startup never blocks the front end. `buildToolSet()` runs once per agent
 * turn, so a server that finishes its handshake after the TUI has painted is
 * simply offered on the next turn. A server that fails to start logs a warning
 * and is skipped; it never prevents a session.
 */
import { connectServer, type McpServer } from "./client.ts";
import { enabledServers, loadMcpServers, type McpServerConfig } from "./config.ts";
import { jsonSchemaToZod } from "./schema.ts";
import { registerTool, unregisterToolsByPrefix } from "../tools/registry.ts";
import type { PermissionLevel, ToolDefinition } from "../tools/types.ts";
import { logger } from "../utils/logger.ts";

/** Namespace prefix, so a remote tool can never be mistaken for a local one. */
export const MCP_PREFIX = "mcp__";

/** `mcp__github__get_file_contents` */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`;
}

const running = new Map<string, McpServer>();

/**
 * What level a remote tool runs at.
 *
 * `network` unless the user said otherwise. Not `write`: `standard` mode
 * auto-allows `write`, so filing remote tools there would let an unclassified
 * one execute silently in the default mode — the opposite of failing closed.
 */
function levelFor(config: McpServerConfig, toolName: string): PermissionLevel {
  return config.permissions?.[toolName] ?? "network";
}

function defineTool(server: McpServer, config: McpServerConfig, tool: { name: string; description: string; inputSchema: unknown }): ToolDefinition {
  return {
    name: mcpToolName(server.name, tool.name),
    description: `${tool.description}\n\n(Provided by the "${server.name}" MCP server.)`,
    parameters: jsonSchemaToZod(tool.inputSchema),
    permissionLevel: levelFor(config, tool.name),
    async execute(args) {
      return server.call(tool.name, (args ?? {}) as Record<string, unknown>);
    },
  } as ToolDefinition;
}

export interface McpStartResult {
  servers: string[];
  tools: number;
  failed: Array<{ server: string; error: string }>;
}

/** Connect one server and register everything it offers. */
async function startOne(
  name: string,
  config: McpServerConfig,
  cwd: string,
): Promise<{ tools: number }> {
  const server = await connectServer(name, config, { cwd });
  running.set(name, server);

  let registered = 0;
  for (const tool of server.tools) {
    if (registerTool(defineTool(server, config, tool))) registered++;
    else logger.warn("mcp: tool name collides with a built-in — skipped", { server: name, tool: tool.name });
  }

  return { tools: registered };
}

/**
 * Start every enabled server. Servers come up concurrently and independently:
 * one that hangs on its handshake must not hold up the others.
 */
export async function startMcpServers(projectRoot: string): Promise<McpStartResult> {
  const declared = enabledServers(loadMcpServers(projectRoot));
  if (declared.length === 0) return { servers: [], tools: 0, failed: [] };

  const result: McpStartResult = { servers: [], tools: 0, failed: [] };

  await Promise.all(
    declared.map(async ([name, config]) => {
      try {
        const { tools } = await startOne(name, config, projectRoot);
        result.servers.push(name);
        result.tools += tools;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result.failed.push({ server: name, error });
        logger.warn("mcp: server failed to start — skipped", { server: name, error });
      }
    }),
  );

  return result;
}

/**
 * Close every server and drop its tools.
 *
 * Fire-and-forget by design: this runs from the `exit` handler, which cannot
 * await. Closing the transport kills the child, and an orphaned `npx` server
 * outliving the TUI is the failure mode users actually notice.
 */
export function stopMcpServers(): void {
  for (const [name, server] of running) {
    unregisterToolsByPrefix(`${MCP_PREFIX}${name}__`);
    void server.close().catch(() => {});
  }
  running.clear();
}

/** Names of the servers currently connected. */
export function runningServers(): string[] {
  return [...running.keys()];
}

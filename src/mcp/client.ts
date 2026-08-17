/**
 * MCP client — spawn a stdio server, handshake, list its tools, call them.
 *
 * Wraps `@modelcontextprotocol/sdk` behind an interface of our own so the rest
 * of the tree never imports the SDK directly. That is the whole point of the
 * wrapper: the protocol revs, and when it does the change should land here.
 *
 * stdio only for now. HTTP/SSE brings OAuth, token refresh and a callback
 * listener — a second project, not a second branch of this one.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expandEnvVars, type McpServerConfig } from "./config.ts";
import { logger } from "../utils/logger.ts";

/** Name Codemon introduces itself with during the handshake. */
const CLIENT_INFO = { name: "codemon", version: "1.0.0" };

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpServer {
  name: string;
  tools: McpToolInfo[];
  call(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * MCP returns a content array of typed parts. Flatten it into something a tool
 * result can carry: text parts joined, anything else kept as structured JSON.
 */
export function normaliseToolResult(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;

  const record = result as Record<string, unknown>;

  // Newer servers return `structuredContent` alongside the human-readable
  // parts; prefer it, since it is the machine-readable half by definition.
  if (record.structuredContent !== undefined) return record.structuredContent;

  const content = record.content;
  if (!Array.isArray(content)) return result;

  const texts: string[] = [];
  const others: unknown[] = [];

  for (const part of content) {
    if (typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text") {
      texts.push(String((part as Record<string, unknown>).text ?? ""));
    } else {
      others.push(part);
    }
  }

  const isError = record.isError === true;

  if (others.length === 0) {
    const text = texts.join("\n");
    return isError ? { error: text } : text;
  }

  return { text: texts.join("\n"), content: others, ...(isError ? { error: true } : {}) };
}

/** Expand `${VAR}` through every declared value at spawn time. */
function resolveEnv(config: McpServerConfig): Record<string, string> {
  const declared: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.env ?? {})) {
    declared[key] = expandEnvVars(value);
  }
  // The SDK's default set is a safe-to-inherit subset (PATH, HOME and friends);
  // a server that needs more says so in `env`.
  return { ...getDefaultEnvironment(), ...declared };
}

/**
 * Spawn a server and complete the handshake. Rejects rather than returning a
 * half-live server — the caller logs it and carries on without that one.
 */
export async function connectServer(
  name: string,
  config: McpServerConfig,
  options: { cwd?: string } = {},
): Promise<McpServer> {
  const timeout = config.timeout ?? 30_000;

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: resolveEnv(config),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // Servers use stderr for their own logging; letting it inherit would paint
    // over the TUI mid-frame.
    stderr: "pipe",
  });

  const client = new Client(CLIENT_INFO, { capabilities: {} });

  await client.connect(transport, { timeout });

  const listed = await client.listTools(undefined, { timeout });
  const tools: McpToolInfo[] = (listed.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? `${t.name} (from the "${name}" MCP server)`,
    inputSchema: t.inputSchema,
  }));

  logger.info("mcp: server ready", { server: name, tools: tools.length });

  return {
    name,
    tools,
    async call(toolName, args) {
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout },
      );
      return normaliseToolResult(result);
    },
    async close() {
      try {
        await client.close();
      } catch (err) {
        logger.warn("mcp: error closing server", { server: name, error: String(err) });
      }
    },
  };
}

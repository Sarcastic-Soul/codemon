#!/usr/bin/env bun
/**
 * A minimal MCP server over stdio, used by client.test.ts.
 *
 * Hand-rolled JSON-RPC rather than built on the SDK's server half: the point is
 * to test our client against the wire format, and a fixture that shares the
 * other side's implementation would pass even if both were wrong together.
 */

interface Request {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo a message back",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "What to echo" } },
      required: ["message"],
    },
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}

function handle(req: Request): void {
  // Notifications carry no id and get no response.
  if (req.id === undefined) return;

  switch (req.method) {
    case "initialize":
      send({
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "echo-server", version: "0.0.1" },
        },
      });
      return;

    case "tools/list":
      send({ id: req.id, result: { tools: TOOLS } });
      return;

    case "tools/call": {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

      if (name === "echo") {
        send({ id: req.id, result: { content: [{ type: "text", text: String(args.message ?? "") }] } });
        return;
      }
      if (name === "add") {
        send({
          id: req.id,
          result: { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] },
        });
        return;
      }
      if (name === "boom") {
        send({ id: req.id, result: { isError: true, content: [{ type: "text", text: "tool failed" }] } });
        return;
      }

      send({ id: req.id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } });
      return;
    }

    default:
      send({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    try {
      handle(JSON.parse(line) as Request);
    } catch {
      // A malformed line is the client's problem; staying up is ours.
    }
  }
});

process.stdin.on("end", () => process.exit(0));

import { describe, test, expect, afterAll } from "bun:test";
import * as path from "path";
import { connectServer, normaliseToolResult, type McpServer } from "./client.ts";
import { expandEnvVars } from "./config.ts";
import { jsonSchemaToZod } from "./schema.ts";
import { mcpToolName } from "./index.ts";

const FIXTURE = path.join(import.meta.dir, "fixtures", "echo-server.ts");

const opened: McpServer[] = [];

async function connect(): Promise<McpServer> {
  const server = await connectServer("echo", { command: "bun", args: [FIXTURE], timeout: 15_000 });
  opened.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(opened.map((s) => s.close().catch(() => {})));
});

describe("stdio MCP server", () => {
  test("handshake, list and call round-trip against a real child process", async () => {
    const server = await connect();

    expect(server.tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);
    expect(await server.call("echo", { message: "hello" })).toBe("hello");
    expect(await server.call("add", { a: 2, b: 3 })).toBe("5");
  }, 30_000);

  test("a tool error comes back as an error field rather than a thrown exception", async () => {
    const server = await connect();
    const result = (await server.call("boom", {})) as { error?: string };
    expect(result.error).toBe("tool failed");
  }, 30_000);

  test("an unknown tool rejects", async () => {
    const server = await connect();
    await expect(server.call("no_such_tool", {})).rejects.toThrow();
  }, 30_000);

  test("a listed tool's schema converts into something usable", async () => {
    const server = await connect();
    const echo = server.tools.find((t) => t.name === "echo")!;
    const zod = jsonSchemaToZod(echo.inputSchema);

    expect(zod.safeParse({ message: "hi" }).success).toBe(true);
    expect(zod.safeParse({}).success).toBe(false);
  }, 30_000);

  test("a server that cannot start rejects rather than hanging", async () => {
    await expect(
      connectServer("broken", {
        command: "definitely-not-a-real-executable-xyz",
        timeout: 5_000,
      }),
    ).rejects.toThrow();
  }, 30_000);

  test("closing twice is harmless", async () => {
    const server = await connect();
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  }, 30_000);
});

describe("result normalisation", () => {
  test("a single text part flattens to a string", () => {
    expect(normaliseToolResult({ content: [{ type: "text", text: "hi" }] })).toBe("hi");
  });

  test("multiple text parts join on newlines", () => {
    expect(
      normaliseToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    ).toBe("a\nb");
  });

  test("isError becomes an error field the loop can surface", () => {
    expect(normaliseToolResult({ isError: true, content: [{ type: "text", text: "nope" }] })).toEqual({
      error: "nope",
    });
  });

  test("structuredContent wins — it is the machine-readable half by definition", () => {
    expect(
      normaliseToolResult({ structuredContent: { count: 2 }, content: [{ type: "text", text: "2" }] }),
    ).toEqual({ count: 2 });
  });

  test("non-text parts are kept rather than dropped", () => {
    const result = normaliseToolResult({
      content: [{ type: "text", text: "see" }, { type: "image", data: "…" }],
    }) as { text: string; content: unknown[] };

    expect(result.text).toBe("see");
    expect(result.content).toHaveLength(1);
  });
});

describe("env expansion", () => {
  test("${VAR} expands from the environment", () => {
    process.env.CODEMON_TEST_TOKEN = "s3cret";
    expect(expandEnvVars("Bearer ${CODEMON_TEST_TOKEN}")).toBe("Bearer s3cret");
    delete process.env.CODEMON_TEST_TOKEN;
  });

  test("an unset variable expands to empty, not to the literal placeholder", () => {
    // A server should fail to authenticate rather than authenticate as the
    // string "${TOKEN}".
    expect(expandEnvVars("${CODEMON_DEFINITELY_UNSET}")).toBe("");
  });

  test("text with no placeholder is untouched", () => {
    expect(expandEnvVars("plain value")).toBe("plain value");
  });
});

describe("tool naming", () => {
  test("remote tools are namespaced so they cannot be mistaken for local ones", () => {
    expect(mcpToolName("github", "get_file_contents")).toBe("mcp__github__get_file_contents");
  });
});

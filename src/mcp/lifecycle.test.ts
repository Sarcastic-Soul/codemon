import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MCP_PREFIX, runningServers, startMcpServers, stopMcpServers } from "./index.ts";
import { buildToolSet, getTool, unregisterToolsByPrefix } from "../tools/registry.ts";
import { checkPermission } from "../permissions/gate.ts";

const FIXTURE = path.join(import.meta.dir, "fixtures", "echo-server.ts");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codemon-mcp-life-"));
  fs.mkdirSync(path.join(root, ".codemon"), { recursive: true });
});

afterEach(() => {
  stopMcpServers();
  unregisterToolsByPrefix(MCP_PREFIX);
  fs.rmSync(root, { recursive: true, force: true });
});

function declareServers(servers: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(root, ".codemon", "config.json"),
    JSON.stringify({ mcpServers: servers }),
  );
}

describe("MCP lifecycle", () => {
  test("a declared server's tools become callable, namespaced tools", async () => {
    declareServers({ echo: { command: "bun", args: [FIXTURE], timeout: 15_000 } });

    const result = await startMcpServers(root);

    expect(result.servers).toEqual(["echo"]);
    expect(result.tools).toBe(2);
    expect(runningServers()).toEqual(["echo"]);

    const tool = getTool("mcp__echo__echo");
    expect(tool).toBeDefined();
    expect(await tool!.execute({ message: "round trip" })).toBe("round trip");
  }, 30_000);

  test("registered tools reach the model through buildToolSet", async () => {
    declareServers({ echo: { command: "bun", args: [FIXTURE], timeout: 15_000 } });
    await startMcpServers(root);

    // buildToolSet runs once per agent turn, which is why a server that comes
    // up after startup is simply offered on the next turn.
    expect(Object.keys(buildToolSet())).toContain("mcp__echo__add");
  }, 30_000);

  test("an unclassified remote tool asks in standard mode", async () => {
    declareServers({ echo: { command: "bun", args: [FIXTURE], timeout: 15_000 } });
    await startMcpServers(root);

    const tool = getTool("mcp__echo__echo")!;
    expect(tool.permissionLevel).toBe("network");
    expect(checkPermission(tool.name, tool.permissionLevel, "standard")).toBe("ask");
  }, 30_000);

  test("a per-tool override opts a read-only tool down", async () => {
    declareServers({
      echo: { command: "bun", args: [FIXTURE], timeout: 15_000, permissions: { echo: "read" } },
    });
    await startMcpServers(root);

    expect(getTool("mcp__echo__echo")!.permissionLevel).toBe("read");
    // The override is per tool, so its sibling is untouched.
    expect(getTool("mcp__echo__add")!.permissionLevel).toBe("network");
  }, 30_000);

  test("a server that fails to start is reported and skipped, not fatal", async () => {
    declareServers({
      good: { command: "bun", args: [FIXTURE], timeout: 15_000 },
      bad: { command: "definitely-not-a-real-executable-xyz", timeout: 5_000 },
    });

    const result = await startMcpServers(root);

    // The healthy one still came up — one bad server must not cost the session
    // every other server.
    expect(result.servers).toContain("good");
    expect(result.failed.map((f) => f.server)).toEqual(["bad"]);
    expect(getTool("mcp__good__echo")).toBeDefined();
  }, 30_000);

  test("a disabled server is not started", async () => {
    declareServers({ echo: { command: "bun", args: [FIXTURE], enabled: false } });

    const result = await startMcpServers(root);
    expect(result.servers).toEqual([]);
    expect(getTool("mcp__echo__echo")).toBeUndefined();
  }, 30_000);

  test("no declarations means no work and no error", async () => {
    const result = await startMcpServers(root);
    expect(result).toEqual({ servers: [], tools: 0, failed: [] });
  });

  test("shutdown drops the tools as well as the processes", async () => {
    declareServers({ echo: { command: "bun", args: [FIXTURE], timeout: 15_000 } });
    await startMcpServers(root);
    expect(getTool("mcp__echo__echo")).toBeDefined();

    stopMcpServers();

    expect(runningServers()).toEqual([]);
    expect(getTool("mcp__echo__echo")).toBeUndefined();
    // Built-ins are untouched by the sweep.
    expect(getTool("read_file")).toBeDefined();
  }, 30_000);

  test("a sub-agent can see MCP tools", async () => {
    declareServers({ echo: { command: "bun", args: [FIXTURE], timeout: 15_000 } });
    await startMcpServers(root);

    // The z.enum const tuple that used to pin this list made MCP tools
    // unreachable from sub-agents — and worse, was what the model saw.
    const { listToolNames } = await import("../tools/registry.ts");
    expect(listToolNames()).toContain("mcp__echo__echo");
  }, 30_000);
});
